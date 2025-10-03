import { readFileSync } from 'node:fs';
import { ask } from '../src/ask';
import type { TopicHint } from '../src/config';

interface GoldenCase {
  q: string;
  hint?: TopicHint;
  must_domain: string;
}

function loadCases(path: string): GoldenCase[] {
  const content = readFileSync(path, 'utf8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as GoldenCase);
}

function extractSources(answer: string): string[] {
  const match = /Sources?:/i.exec(answer);
  if (!match) {
    return [];
  }

  const start = match.index + match[0].length;
  const sourcesBlock = answer
    .slice(start)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const urls: string[] = [];
  const urlRegex = /(https?:\/\/[^)\s]+)/g;
  for (const line of sourcesBlock) {
    let urlMatch: RegExpExecArray | null;
    while ((urlMatch = urlRegex.exec(line)) !== null) {
      urls.push(urlMatch[1]);
    }
  }
  return urls;
}

function matchesDomain(url: string, mustDomain: string): boolean {
  try {
    const parsed = new URL(url);
    const hostPath = `${parsed.host}${parsed.pathname}`.replace(/\/+$|\/+(?=\?)/g, '');
    const normalized = hostPath.replace(/^www\./, '');
    const expected = mustDomain.replace(/^https?:\/\//, '').replace(/^www\./, '');
    return normalized.startsWith(expected);
  } catch {
    const normalized = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
    const expected = mustDomain.replace(/^https?:\/\//, '').replace(/^www\./, '');
    return normalized.startsWith(expected);
  }
}

async function run(path = 'eval/golden_qa.jsonl') {
  const cases = loadCases(path);
  let failures = 0;

  for (const testCase of cases) {
    const { q, hint, must_domain: requiredDomain } = testCase;
    try {
      const result = await ask({ message: q, topicHint: hint });
      const sources = extractSources(result.answer);
      const domainHit = sources.some((url) => matchesDomain(url, requiredDomain));

      if (!domainHit) {
        failures += 1;
        console.error(`✖ Domain mismatch for: "${q}". Found sources: ${sources.join(', ') || 'none'}`);
      } else {
        console.log(`✓ Passed: "${q}"`);
      }
    } catch (error) {
      failures += 1;
      console.error(`✖ Error for: "${q}" →`, error instanceof Error ? error.message : error);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} evaluation case(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${cases.length} evaluation cases passed.`);
  }
}

void run();
