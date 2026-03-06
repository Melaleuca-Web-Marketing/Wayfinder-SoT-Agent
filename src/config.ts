import { config as loadEnv } from 'dotenv';

loadEnv();

type TopicHint = 'melaleuca' | 'riverbend';

function parseNonNegativeNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseVectorStoreIds(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function ensureHttps(domainOrUrl: string): string {
  if (domainOrUrl.startsWith('http://') || domainOrUrl.startsWith('https://')) {
    return domainOrUrl.replace('http://', 'https://');
  }
  return `https://${domainOrUrl.replace(/^https?:\/\//, '')}`;
}

function normalizeDomain(value: string, stripWww = true): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === '*') {
    return '*';
  }

  try {
    const url = new URL(ensureHttps(trimmed));
    const host =
      stripWww ? url.hostname.replace(/^www\./, '').toLowerCase() : url.hostname.toLowerCase();
    return host || null;
  } catch {
    const host = trimmed
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      .trim()
      .toLowerCase();
    const normalizedHost = stripWww ? host.replace(/^www\./, '') : host;
    return normalizedHost || null;
  }
}

function parseDomainAllowlist(raw: string | undefined, defaults: string[], stripWww = true): string[] {
  const candidates = (raw && raw.trim().length > 0 ? raw.split(',') : defaults) ?? [];
  const allowlist = new Set<string>();
  for (const entry of candidates) {
    const normalized = normalizeDomain(entry, stripWww);
    if (normalized) {
      allowlist.add(normalized);
    }
  }
  return Array.from(allowlist.values());
}

export function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('Missing required environment variable: OPENAI_API_KEY');
  }
  return key;
}

const primaryDomain = process.env.PRIMARY_DOMAIN ?? 'melaleuca.com';
const riverbendDomain = process.env.RIVERBEND_DOMAIN ?? 'melaleuca.com/riverbendranch';
const vectorUrlAllowlist = parseDomainAllowlist(process.env.VECTOR_URL_ALLOWLIST, []);

export const settings = {
  model: process.env.OPENAI_MODEL ?? 'gpt-5.4',
  openAiRequestTimeoutMs: parseNonNegativeNumber(process.env.OPENAI_REQUEST_TIMEOUT_MS, 60000),
  openAiMaxRetries: parseNonNegativeNumber(process.env.OPENAI_MAX_RETRIES, 0),
  primaryDomain,
  riverbendDomain,
  webCacheTtlSeconds: Number(process.env.WEB_CACHE_TTL_SECONDS ?? '86400'),
  vectorStoreIds: parseVectorStoreIds(process.env.VECTOR_STORE_ID),
  // Preserve exact hosts (including www) so web_search filters can be strict.
  webSearchAllowedDomains: parseDomainAllowlist(process.env.WEB_SEARCH_ALLOWED_DOMAINS, [], false),
  webSearchCountry: process.env.WEB_SEARCH_COUNTRY ?? 'US',
  webSearchRegion: process.env.WEB_SEARCH_REGION,
  webSearchCity: process.env.WEB_SEARCH_CITY,
  webSearchTimezone: process.env.WEB_SEARCH_TIMEZONE,
  vectorUrlAllowlist,
};

export type { TopicHint };
