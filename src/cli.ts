#!/usr/bin/env node
import { ask } from './ask.js';
import type { TopicHint } from './config.js';

function parseArgs(argv: string[]): { message: string; topicHint?: TopicHint } {
  const args = [...argv];
  let topicHint: TopicHint | undefined;
  const messageParts: string[] = [];

  while (args.length > 0) {
    const current = args.shift()!;
    if (current.startsWith('--hint=')) {
      topicHint = toTopicHint(current.split('=')[1]);
      continue;
    }
    if (current === '--hint') {
      const value = args.shift();
      topicHint = toTopicHint(value ?? '');
      continue;
    }
    messageParts.push(current);
  }

  const message = messageParts.join(' ').trim();
  if (!message) {
    throw new Error('Usage: npm run dev:ask -- "<question>" [--hint melaleuca|riverbend]');
  }

  return { message, topicHint };
}

function toTopicHint(raw: string): TopicHint {
  const value = raw.toLowerCase();
  if (value === 'riverbend') {
    return 'riverbend';
  }
  return 'melaleuca';
}

async function main() {
  try {
    const [, , ...rest] = process.argv;
    const { message, topicHint } = parseArgs(rest);
    const result = await ask({ message, topicHint });

    if (result.answer.length === 0) {
      console.warn('No answer returned by the model. Check logs for details.');
      return;
    }

    console.log(result.answer);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

void main();
