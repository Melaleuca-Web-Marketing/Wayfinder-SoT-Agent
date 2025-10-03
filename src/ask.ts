import OpenAI from 'openai';
import type { Response } from 'openai/resources/responses/responses';
import { requireApiKey, settings, type TopicHint } from './config';

export interface AskParams {
  message: string;
  topicHint?: TopicHint;
  vectorStoreIds?: string[];
  model?: string;
  history?: ConversationTurn[];
}

export interface AskResult {
  answer: string;
  response: Response;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

const client = new OpenAI({ apiKey: requireApiKey() });

function inferTopicHint(message: string): TopicHint {
  const normalized = message.toLowerCase();
  if (normalized.includes('riverbend') || normalized.includes('beef')) {
    return 'riverbend';
  }
  return 'melaleuca';
}

interface DomainConfig {
  preferredDomains: string[];
  fallbackUrl: string;
}

function buildDomainConfig(topicHint: TopicHint): DomainConfig {
  const primaryDomain = ensureHttps(settings.primaryDomain);
  const riverbendDomain = ensureHttps(settings.riverbendDomain);

  if (topicHint === 'riverbend') {
    return {
      preferredDomains: [riverbendDomain, primaryDomain],
      fallbackUrl: riverbendDomain,
    };
  }

  return {
    preferredDomains: [primaryDomain, riverbendDomain],
    fallbackUrl: primaryDomain,
  };
}

function ensureHttps(domainOrUrl: string): string {
  if (domainOrUrl.startsWith('http://') || domainOrUrl.startsWith('https://')) {
    return domainOrUrl.replace('http://', 'https://');
  }
  return `https://${domainOrUrl.replace(/^https?:\/\//, '')}`;
}

function buildSystemPrompt(domainConfig: DomainConfig): string {
  const [primary, secondary] = domainConfig.preferredDomains;
  const fallbackUrl = domainConfig.fallbackUrl;
  const siteDirectives = domainConfig.preferredDomains
    .map((domain, index) => `${index + 1}. ${domain}`)
    .join('\n');
  const secondaryDirective = secondary
    ? `- If that fails and you have a second domain, try it next using "site:${stripScheme(secondary)}".\n`
    : '';

  return `You are Melaleuca's web-first knowledge agent. Follow these rules strictly:\n\n` +
    `Retrieval order\n` +
    `1. Use web_search first. Prefer results from these domains, in order:\n${siteDirectives}\n` +
    `2. If on-domain results are weak, call file_search on the provided vector stores.\n` +
    `3. If both fail, respond with: "I couldn't confirm from our site or files. Please check: ${fallbackUrl}."\n\n` +
    `Grounding & citations\n` +
    `- Only synthesize from retrieved sources.\n` +
    `- Always include a Sources section listing exact URLs (or document titles + canonical_id for files).\n\n` +
    `Domain selection heuristics\n` +
    `- Default to "site:${stripScheme(primary)}" in web_search queries.\n` +
    secondaryDirective +
    `- Never use broader web results for Melaleuca or Riverbend topics. If no allowlisted sources resolve the question, fall back.\n\n` +
    `Formatting\n` +
    `- Keep answers concise.\n` +
    `- Include effective dates when the source provides them.\n` +
    `- Your final message must end with a section that begins with "Sources:" on its own line, followed by bullet links to every cited source. Do not respond without this section.`;
}

type ToolDefinition =
  | {
      type: 'web_search_preview' | 'web_search_preview_2025_03_11';
      search_context_size?: 'low' | 'medium' | 'high';
    }
  | {
      type: 'file_search';
      vector_store_ids: string[];
      max_num_results?: number;
    };

function buildTools(vectorStoreIds: string[] | undefined): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      type: 'web_search_preview_2025_03_11',
      search_context_size: 'medium',
    },
  ];

  const stores = vectorStoreIds ?? settings.vectorStoreIds;
  if (stores.length > 0) {
    tools.push({
      type: 'file_search',
      vector_store_ids: stores,
      max_num_results: 5,
    });
  }

  return tools;
}

function extractFirstMessageText(response: Response): string {
  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      return item.content
        .map((piece) => (piece.type === 'output_text' ? piece.text : ''))
        .join('\n')
        .trim();
    }
  }
  return '';
}

export async function ask(params: AskParams): Promise<AskResult> {
  const message = params.message.trim();
  if (!message) {
    throw new Error('Message must be provided');
  }

  const topic = params.topicHint ?? inferTopicHint(message);
  const domainConfig = buildDomainConfig(topic);
  const model = params.model ?? settings.model;
  const tools = buildTools(params.vectorStoreIds);
  const systemPrompt = buildSystemPrompt(domainConfig);

  const historyTranscript = formatHistory(params.history ?? []);

  const response = await client.responses.create({
    model,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: systemPrompt,
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: buildUserMessage(message, domainConfig, historyTranscript),
          },
        ],
      },
    ],
    tools,
    metadata: {
      topic_hint: topic,
      primary_domain: domainConfig.preferredDomains[0],
    },
  });

  const answerWithSources = ensureSourcesSection(normalizeAnswer(response));
  if (!hasSourcesSection(answerWithSources)) {
    console.warn('Model response missing Sources section.');
  }

  return {
    answer: answerWithSources,
    response,
  };
}

function normalizeAnswer(response: Response): string {
  if (response.output_text && response.output_text.trim().length > 0) {
    return response.output_text.trim();
  }
  return extractFirstMessageText(response);
}

function buildUserMessage(message: string, domainConfig: DomainConfig, historyTranscript?: string | null): string {
  const [primaryDomain, secondaryDomain] = domainConfig.preferredDomains;
  const followUp = secondaryDomain
    ? ` If nothing relevant returns, try the next allowlisted domain.`
    : '';

  const conversation = historyTranscript ? `${historyTranscript}\nUser: ${message}` : message;

  return `${conversation}\n\n(Use web_search with site:${stripScheme(primaryDomain)} first.${followUp})`;
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

function hasSourcesSection(answer: string): boolean {
  return /(^|\n)\s*Sources\s*:/i.test(answer);
}

function formatHistory(history: ConversationTurn[]): string | null {
  if (history.length === 0) {
    return null;
  }

  return history
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
    .join('\n');
}

function extractUrls(answer: string): string[] {
  const urlRegex = /https?:\/\/[^\s)\]]+/g;
  const urls = new Map<string, string>();
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(answer)) !== null) {
    const raw = match[0].replace(/[,.;]+$/, '');
    try {
      const parsed = new URL(raw);
      parsed.searchParams.delete('utm_source');
      parsed.searchParams.delete('utm_medium');
      parsed.searchParams.delete('utm_campaign');
      parsed.searchParams.delete('utm_term');
      parsed.searchParams.delete('utm_content');
      const key = parsed.origin + parsed.pathname;
      const cleaned = parsed.search ? `${key}?${parsed.searchParams.toString()}` : key;
      if (!urls.has(key)) {
        urls.set(key, cleaned);
      }
    } catch {
      urls.set(raw, raw);
    }
  }
  return Array.from(urls.values());
}

function ensureSourcesSection(answer: string): string {
  if (!answer.trim()) {
    return answer;
  }

  if (hasSourcesSection(answer)) {
    return answer;
  }

  const urls = extractUrls(answer);
  if (urls.length === 0) {
    return answer;
  }

  const sourcesLines = urls.map((url) => `- ${url}`);
  return `${answer.trim()}\n\nSources:\n${sourcesLines.join('\n')}`;
}
