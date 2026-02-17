import { promises as fs } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { OpenAI, toFile } from 'openai';
import { requireApiKey, settings } from './config.js';

const client = new OpenAI({ apiKey: requireApiKey() });
const metaFile = path.resolve('.vector-store.json');
let cachedVectorStoreId: string | null = null;
const MAX_URL_BYTES = Number(process.env.MAX_URL_BYTES ?? String(5 * 1024 * 1024));
const URL_FETCH_TIMEOUT_MS = Number(process.env.URL_FETCH_TIMEOUT_MS ?? '15000');
const VECTOR_URL_AUTH_MODE = (process.env.VECTOR_URL_AUTH_MODE ?? 'none').trim().toLowerCase();
const VECTOR_URL_AUTH_DOMAIN = normalizeHost(process.env.VECTOR_URL_AUTH_DOMAIN ?? '');
const VECTOR_URL_AUTH_COOKIE = process.env.VECTOR_URL_AUTH_COOKIE?.trim() ?? '';
const VECTOR_URL_AUTH_COOKIE_FILE = process.env.VECTOR_URL_AUTH_COOKIE_FILE?.trim() ?? 'authcookie.sh';
const VECTOR_URL_USER_AGENT =
  process.env.VECTOR_URL_USER_AGENT ??
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const VECTOR_URL_ACCEPT_LANGUAGE = process.env.VECTOR_URL_ACCEPT_LANGUAGE ?? 'en-US,en;q=0.9';
const URL_DOWNLOAD_DIR = path.join(process.env.TMPDIR ?? '/tmp', 'wayfinder-url-imports');
const SUPPORTED_URL_CONTENT_TYPES = new Set([
  'text/html',
  'text/plain',
  'text/markdown',
  'text/md',
  'application/pdf',
  'application/xhtml+xml',
  'application/json',
  'application/xml',
]);
const SUPPORTED_URL_EXTENSIONS = new Set(['.pdf', '.md', '.markdown', '.txt', '.html', '.htm']);
let cachedAuthCookieFromFile: string | null | undefined;

class VectorUrlImportError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'VectorUrlImportError';
    this.statusCode = statusCode;
  }
}

export function isVectorUrlImportError(error: unknown): error is VectorUrlImportError {
  return error instanceof VectorUrlImportError;
}

interface VectorStoreMeta {
  id: string;
  name: string;
  created_at: number;
}

export async function ensureVectorStoreId(): Promise<string> {
  if (cachedVectorStoreId) {
    return cachedVectorStoreId;
  }

  const configuredId = settings.vectorStoreIds[0];
  if (configuredId) {
    await assertVectorStoreAccessible(configuredId);
    cachedVectorStoreId = configuredId;
    return configuredId;
  }

  const meta = await readMeta();
  if (meta) {
    const exists = await vectorStoreExists(meta.id);
    if (exists) {
      cachedVectorStoreId = meta.id;
      settings.vectorStoreIds = [meta.id];
      return meta.id;
    }

    await removeMeta();
  }

  const storeId = await createVectorStore();
  cachedVectorStoreId = storeId;
  settings.vectorStoreIds = [storeId];
  return storeId;
}

export async function getVectorStoreDetails() {
  const id = await ensureVectorStoreId();
  const store = await client.vectorStores.retrieve(id);
  return { id: store.id, name: store.name, file_count: store.file_counts?.total ?? 0 };
}

export async function listVectorStoreFiles() {
  const id = await ensureVectorStoreId();
  const files = await client.vectorStores.files.list(id, { limit: 50 });
  type VectorStoreListFile = (typeof files.data)[number];
  return files.data.map((file: VectorStoreListFile) => ({
    id: file.id,
    status: file.status,
    name: (file.attributes?.filename as string | undefined) ?? file.id,
    source_url: (file.attributes?.source_url as string | undefined) ?? null,
    created_at: file.created_at,
    last_error: file.last_error ?? null,
  }));
}

export async function uploadFileToVectorStore(localPath: string, filename: string) {
  const id = await ensureVectorStoreId();
  const file = await client.files.create({
    file: await toFile(createReadStream(localPath), filename),
    purpose: 'assistants',
  });

  const vectorStoreFile = await client.vectorStores.files.create(id, {
    file_id: file.id,
    attributes: {
      filename,
    },
  });

  return {
    vector_store_file_id: vectorStoreFile.id,
    file_id: file.id,
    status: vectorStoreFile.status,
  };
}

export async function uploadUrlToVectorStore(targetUrl: string, filename?: string) {
  const url = normalizeUrl(targetUrl);
  if (!isUrlAllowed(url)) {
    throw new VectorUrlImportError('URL not allowed. Update VECTOR_URL_ALLOWLIST to include this domain.', 403);
  }

  await fs.mkdir(URL_DOWNLOAD_DIR, { recursive: true });
  const headers = await buildUrlFetchHeaders(url);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url.toString(), { redirect: 'follow', signal: controller.signal, headers });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new VectorUrlImportError(`URL fetch timed out after ${URL_FETCH_TIMEOUT_MS}ms.`, 504);
    }
    throw new VectorUrlImportError('Failed to fetch URL.', 502);
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    throw new VectorUrlImportError(`Failed to fetch URL (${response.status} ${response.statusText}).`, 502);
  }

  const contentType = normalizeContentType(response.headers.get('content-type'));
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > 0 && contentLength > MAX_URL_BYTES) {
    throw new VectorUrlImportError(`URL content exceeds ${MAX_URL_BYTES} bytes.`, 413);
  }

  const derivedName = deriveFilename(url, contentType, filename);
  if (!isSupportedUrlAsset(derivedName, contentType)) {
    throw new VectorUrlImportError('Unsupported URL content type. Use HTML, text, Markdown, or PDF.', 415);
  }

  const safeName = sanitizeFilename(derivedName);
  const tempPath = path.join(
    URL_DOWNLOAD_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`,
  );

  try {
    if (!response.body) {
      throw new VectorUrlImportError('No response body returned for URL.', 502);
    }

    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        const nextSize = (this as Transform & { bytesWritten?: number }).bytesWritten ?? 0;
        const updated = nextSize + chunk.length;
        (this as Transform & { bytesWritten?: number }).bytesWritten = updated;
        if (updated > MAX_URL_BYTES) {
          callback(new Error(`URL content exceeds ${MAX_URL_BYTES} bytes.`));
          return;
        }
        callback(null, chunk);
      },
    });

    const nodeStream = Readable.fromWeb(response.body as unknown as NodeReadableStream);
    try {
      await pipeline(nodeStream, limiter, createWriteStream(tempPath));
    } catch (error) {
      if (error instanceof Error && error.message.includes('URL content exceeds')) {
        throw new VectorUrlImportError(error.message, 413);
      }
      throw error;
    }

    const id = await ensureVectorStoreId();
    const file = await client.files.create({
      file: await toFile(createReadStream(tempPath), safeName),
      purpose: 'assistants',
    });

    const vectorStoreFile = await client.vectorStores.files.create(id, {
      file_id: file.id,
      attributes: {
        filename: safeName,
        source_url: url.toString(),
      },
    });

    return {
      vector_store_file_id: vectorStoreFile.id,
      file_id: file.id,
      status: vectorStoreFile.status,
    };
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

export async function deleteVectorStoreFile(fileId: string) {
  const id = await ensureVectorStoreId();
  await client.vectorStores.files.del(id, fileId);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && (error as any).status === 404;
}

async function vectorStoreExists(id: string): Promise<boolean> {
  try {
    await client.vectorStores.retrieve(id);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

async function assertVectorStoreAccessible(id: string): Promise<void> {
  const exists = await vectorStoreExists(id);
  if (!exists) {
    throw new Error(
      `Vector store ${id} is not accessible with the current API key. ` +
        'Update VECTOR_STORE_ID in the environment or remove it to create a new store.',
    );
  }
}

async function createVectorStore(): Promise<string> {
  const store = await client.vectorStores.create({
    name: 'melaleuca-knowledge-base',
    metadata: {
      project: 'melaleuca-web-first',
    },
  });

  const record: VectorStoreMeta = {
    id: store.id,
    name: store.name,
    created_at: Date.now(),
  };

  await writeMeta(record);
  return store.id;
}

async function readMeta(): Promise<VectorStoreMeta | null> {
  try {
    const raw = await fs.readFile(metaFile, 'utf8');
    return JSON.parse(raw) as VectorStoreMeta;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeMeta(meta: VectorStoreMeta): Promise<void> {
  await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8');
}

async function removeMeta(): Promise<void> {
  await fs.rm(metaFile, { force: true });
}

function normalizeUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new VectorUrlImportError('Only http(s) URLs are supported.', 400);
    }
    return url;
  } catch (error) {
    if (isVectorUrlImportError(error)) {
      throw error;
    }
    throw new VectorUrlImportError('Invalid URL provided.', 400);
  }
}

function normalizeHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .trim();
}

function isUrlAllowed(url: URL): boolean {
  const allowlist = settings.vectorUrlAllowlist ?? [];
  if (allowlist.length === 0) {
    return true;
  }
  if (allowlist.includes('*')) {
    return true;
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  return allowlist.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

async function buildUrlFetchHeaders(url: URL): Promise<Headers> {
  const headers = new Headers({
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/markdown;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    'Accept-Language': VECTOR_URL_ACCEPT_LANGUAGE,
    'Cache-Control': 'no-cache',
    'User-Agent': VECTOR_URL_USER_AGENT,
  });

  const cookie = await resolveAuthCookie(url);
  if (cookie) {
    headers.set('Cookie', cookie);
  }

  return headers;
}

async function resolveAuthCookie(url: URL): Promise<string | undefined> {
  if (VECTOR_URL_AUTH_MODE !== 'cookie') {
    return undefined;
  }

  if (!isAuthDomainMatch(url)) {
    return undefined;
  }

  if (VECTOR_URL_AUTH_COOKIE.length > 0) {
    return VECTOR_URL_AUTH_COOKIE;
  }

  const fileCookie = await loadAuthCookieFromFile();
  if (fileCookie) {
    return fileCookie;
  }

  throw new VectorUrlImportError(
    'VECTOR_URL_AUTH_MODE=cookie but no cookie is configured. Set VECTOR_URL_AUTH_COOKIE (recommended for Vercel).',
    500,
  );
}

function isAuthDomainMatch(url: URL): boolean {
  if (!VECTOR_URL_AUTH_DOMAIN) {
    return true;
  }

  const host = normalizeHost(url.hostname);
  return host === VECTOR_URL_AUTH_DOMAIN || host.endsWith(`.${VECTOR_URL_AUTH_DOMAIN}`);
}

async function loadAuthCookieFromFile(): Promise<string | undefined> {
  if (cachedAuthCookieFromFile !== undefined) {
    return cachedAuthCookieFromFile ?? undefined;
  }

  try {
    const filePath = path.resolve(VECTOR_URL_AUTH_COOKIE_FILE);
    const raw = await fs.readFile(filePath, 'utf8');
    const cookie = extractCookieFromCurlScript(raw) ?? raw.trim();
    cachedAuthCookieFromFile = cookie.length > 0 ? cookie : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cachedAuthCookieFromFile = null;
      return undefined;
    }
    throw error;
  }

  return cachedAuthCookieFromFile ?? undefined;
}

function extractCookieFromCurlScript(raw: string): string | null {
  const cookieFlagMatch = raw.match(/(?:^|\s)-b\s+(['"])([\s\S]*?)\1/);
  if (cookieFlagMatch?.[2]) {
    return cookieFlagMatch[2].trim();
  }

  const cookieHeaderMatch = raw.match(/(?:^|\s)-H\s+(['"])cookie:\s*([\s\S]*?)\1/i);
  if (cookieHeaderMatch?.[2]) {
    return cookieHeaderMatch[2].trim();
  }

  return null;
}

function normalizeContentType(value: string | null): string {
  return (value ?? '').split(';')[0].trim().toLowerCase();
}

function deriveFilename(url: URL, contentType: string, provided?: string): string {
  const raw = provided && provided.trim().length > 0 ? provided.trim() : '';
  const base = raw || path.basename(url.pathname) || 'document';
  const sanitizedBase = base.replace(/[#?].*$/, '');
  const ext = path.extname(sanitizedBase);
  if (ext) {
    return sanitizedBase;
  }

  const extensionFromType = extensionForContentType(contentType);
  return `${sanitizedBase}${extensionFromType ?? '.txt'}`;
}

function extensionForContentType(contentType: string): string | null {
  if (contentType === 'application/pdf') {
    return '.pdf';
  }
  if (contentType === 'text/markdown' || contentType === 'text/md') {
    return '.md';
  }
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    return '.html';
  }
  if (contentType.startsWith('text/')) {
    return '.txt';
  }
  if (contentType === 'application/json' || contentType === 'application/xml') {
    return '.txt';
  }
  return null;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[\\/]/g, '_');
}

function isSupportedUrlAsset(filename: string, contentType: string): boolean {
  if (contentType && SUPPORTED_URL_CONTENT_TYPES.has(contentType)) {
    return true;
  }
  const ext = path.extname(filename).toLowerCase();
  return ext.length > 0 && SUPPORTED_URL_EXTENSIONS.has(ext);
}

export { client as vectorStoreClient };
