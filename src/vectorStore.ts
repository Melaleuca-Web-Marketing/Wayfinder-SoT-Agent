import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { requireApiKey, settings } from './config';

const client = new OpenAI({ apiKey: requireApiKey() });
const metaFile = path.resolve('.vector-store.json');

interface VectorStoreMeta {
  id: string;
  name: string;
  created_at: number;
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

export async function ensureVectorStoreId(): Promise<string> {
  if (settings.vectorStoreIds.length > 0) {
    return settings.vectorStoreIds[0];
  }

  const meta = await readMeta();
  if (meta) {
    settings.vectorStoreIds = [meta.id];
    return meta.id;
  }

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
  settings.vectorStoreIds = [store.id];
  return store.id;
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

export { client as vectorStoreClient };
