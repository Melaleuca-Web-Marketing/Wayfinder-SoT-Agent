import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { requireApiKey, settings } from './config.js';

const client = new OpenAI({ apiKey: requireApiKey() });
const metaFile = path.resolve('.vector-store.json');
let cachedVectorStoreId: string | null = null;

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
  return files.data.map((file) => ({
    id: file.id,
    status: file.status,
    name: (file.attributes?.filename as string | undefined) ?? file.id,
    created_at: file.created_at,
    last_error: file.last_error ?? null,
  }));
}

export async function uploadFileToVectorStore(localPath: string, filename: string) {
  const id = await ensureVectorStoreId();
  const file = await client.files.create({
    file: await OpenAI.toFile(createReadStream(localPath), filename),
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

export { client as vectorStoreClient };
