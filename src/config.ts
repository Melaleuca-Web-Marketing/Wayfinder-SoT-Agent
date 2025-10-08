import { config as loadEnv } from 'dotenv';

loadEnv();

type TopicHint = 'melaleuca' | 'riverbend';

function parseVectorStoreIds(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('Missing required environment variable: OPENAI_API_KEY');
  }
  return key;
}

export const settings = {
  model: process.env.OPENAI_MODEL ?? 'gpt-4.1',
  primaryDomain: process.env.PRIMARY_DOMAIN ?? 'melaleuca.com',
  riverbendDomain: process.env.RIVERBEND_DOMAIN ?? 'melaleuca.com/riverbendranch',
  webCacheTtlSeconds: Number(process.env.WEB_CACHE_TTL_SECONDS ?? '86400'),
  vectorStoreIds: parseVectorStoreIds(process.env.VECTOR_STORE_ID),
};

export type { TopicHint };
