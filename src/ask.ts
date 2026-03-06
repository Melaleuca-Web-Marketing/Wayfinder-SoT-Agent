import { OpenAI } from 'openai';
import type { Response } from 'openai/resources/responses/responses';
import { requireApiKey, settings, type TopicHint } from './config.js';
import type { ResponseInputMessageContentList } from 'openai/resources/responses/responses';

export type AgentProfile = 'admin' | 'csr';
export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface AskParams {
  message: string;
  topicHint?: TopicHint;
  vectorStoreIds?: string[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  history?: ConversationTurn[];
  images?: AskImage[];
  previousResponseId?: string;
  agentProfile?: AgentProfile;
  onProgress?: (event: AskProgressEvent) => void;
}

export interface AskStreamParams extends AskParams {
  onDraftDelta?: (event: AskDraftDeltaEvent) => void;
  onDraftRevision?: (event: AskDraftRevisionEvent) => void;
}

export interface AskResult {
  answer: string;
  response: Response;
  metrics: AskMetrics;
}

export interface AskStreamResult extends AskResult {
  streamMetrics: AskStreamMetrics;
}

export interface AskRetryMetric {
  reason: 'admin_source_fallback' | 'csr_source_fallback' | 'quality_cleanup';
  attempted: boolean;
  succeeded: boolean;
  durationMs?: number;
}

export interface AskMetrics {
  imageAnalysisMs: number;
  initialResponseMs: number;
  retries: AskRetryMetric[];
  totalMs: number;
}

export interface AskStreamMetrics {
  timeToFirstDeltaMs?: number;
  draftRevisionCount: number;
  streamedCharsPass1: number;
  streamedCharsPass2: number;
}

export interface AskProgressEvent {
  stage:
    | 'initial_response_start'
    | 'initial_response_complete'
    | 'admin_retry_start'
    | 'admin_retry_complete'
    | 'csr_retry_start'
    | 'csr_retry_complete'
    | 'quality_retry_start'
    | 'quality_retry_complete'
    | 'done';
}

export interface AskDraftDeltaEvent {
  draftId: string;
  text: string;
}

export interface AskDraftRevisionEvent {
  fromDraftId: string;
  toDraftId: string;
  reason: 'source_retry' | 'allowlist_replace' | 'quality_retry';
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  images?: ConversationImage[];
}

export interface ConversationImage {
  name?: string;
  mimeType?: string;
}

export interface AskImage {
  data: string;
  mimeType: string;
  name?: string;
}

interface ImageInsight {
  label: string;
  summary: string;
  textSnippets: string[];
  keywords: string[];
}

const client = new OpenAI({
  apiKey: requireApiKey(),
  timeout: settings.openAiRequestTimeoutMs,
  maxRetries: settings.openAiMaxRetries,
});
const ADMIN_FALLBACK_MESSAGE_PREFIX = "I couldn't confirm from our site or files.";
const CSR_FALLBACK_MESSAGE = 'No verified sources found.';
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? '6000');
const IMAGE_ANALYSIS_MODEL = process.env.IMAGE_ANALYSIS_MODEL ?? 'gpt-4o-mini';
const ENABLE_RETRIEVAL_DEBUG_LOGS = parseBooleanEnv('ENABLE_RETRIEVAL_DEBUG_LOGS', false);
const MAX_DEBUG_PREVIEW_CHARS = Number(process.env.RETRIEVAL_DEBUG_PREVIEW_CHARS ?? '220');
const MAX_DEBUG_ITEMS = Number(process.env.RETRIEVAL_DEBUG_MAX_ITEMS ?? '6');
const ENABLE_ANSWER_SELECTION_DEBUG_LOGS = parseBooleanEnv('ENABLE_ANSWER_SELECTION_DEBUG_LOGS', false);
const MAX_ANSWER_DEBUG_CHARS = Number(process.env.ANSWER_DEBUG_MAX_CHARS ?? '12000');
const ENABLE_ANSWER_QUALITY_RETRY = parseBooleanEnv('ENABLE_ANSWER_QUALITY_RETRY', true);
const FORCE_ANSWER_QUALITY_REWRITE = parseBooleanEnv('FORCE_ANSWER_QUALITY_REWRITE', true);
const QUALITY_CHECK_MODEL = process.env.QUALITY_CHECK_MODEL ?? 'gpt-4.1';
const QUALITY_REWRITE_MODEL = process.env.QUALITY_REWRITE_MODEL ?? QUALITY_CHECK_MODEL;
const QUALITY_RETRY_MODEL_PREFIXES = (process.env.QUALITY_RETRY_MODEL_PREFIXES ?? 'gpt-5.4,gpt-5.3-chat')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter((value) => value.length > 0);
const IMAGE_ANALYSIS_SCHEMA = {
  name: 'image_extraction',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'visible_text', 'key_terms'],
    properties: {
      summary: {
        type: 'string',
        description: 'Two concise sentences describing the product and notable claims that are clearly visible.',
      },
      visible_text: {
        type: 'array',
        description: 'Distinct pieces of text that appear on the product or packaging in the image.',
        items: {
          type: 'string',
        },
      },
      key_terms: {
        type: 'array',
        description: '2-5 short keywords or phrases useful for searching company documentation about the product.',
        items: {
          type: 'string',
        },
        minItems: 0,
        maxItems: 6,
      },
    },
  },
} as const;

const ANSWER_QUALITY_CHECK_SCHEMA = {
  name: 'answer_quality_check',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['needs_retry', 'reason', 'suspicious_tokens'],
    properties: {
      needs_retry: {
        type: 'boolean',
      },
      reason: {
        type: 'string',
      },
      suspicious_tokens: {
        type: 'array',
        items: {
          type: 'string',
        },
      },
    },
  },
} as const;

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return fallback;
}

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

function toAllowedDomains(domains: string[]): string[] {
  const allowed = new Set<string>();
  for (const domain of domains) {
    const trimmed = domain.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const url = new URL(ensureHttps(trimmed));
      const host = url.hostname.toLowerCase();
      if (host) {
        allowed.add(host);
      }
      continue;
    } catch {
      // Fall back to a conservative parse if it's not a valid URL.
    }

    const normalized = trimmed
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      .trim()
      .toLowerCase();
    if (normalized) {
      allowed.add(normalized);
    }
  }

  return Array.from(allowed.values());
}

function tightenMelaleucaSearchHosts(domains: string[]): string[] {
  if (domains.length === 0) {
    return domains;
  }

  const normalized = new Set(
    domains
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain.length > 0),
  );

  const hasBroadMelaleucaDomain =
    normalized.has('melaleuca.com') ||
    normalized.has('*.melaleuca.com') ||
    normalized.has('.melaleuca.com');

  if (!hasBroadMelaleucaDomain) {
    return Array.from(normalized.values());
  }

  normalized.delete('melaleuca.com');
  normalized.delete('*.melaleuca.com');
  normalized.delete('.melaleuca.com');
  normalized.add('www.melaleuca.com');
  normalized.add('cdnsc1.melaleuca.com');

  return Array.from(normalized.values());
}

function buildUserLocation():
  | {
      type: 'approximate';
      country?: string;
      region?: string;
      city?: string;
      timezone?: string;
    }
  | undefined {
  const country = settings.webSearchCountry?.trim();
  const region = settings.webSearchRegion?.trim();
  const city = settings.webSearchCity?.trim();
  const timezone = settings.webSearchTimezone?.trim();

  if (!country && !region && !city && !timezone) {
    return undefined;
  }

  return {
    type: 'approximate',
    ...(country ? { country } : {}),
    ...(region ? { region } : {}),
    ...(city ? { city } : {}),
    ...(timezone ? { timezone } : {}),
  };
}

function buildSystemPrompt(domainConfig: DomainConfig, agentProfile: AgentProfile): string {
  if (agentProfile === 'csr') {
    return buildCsrSystemPrompt(domainConfig);
  }
  return buildAdminSystemPrompt(domainConfig);
}

function buildAdminSystemPrompt(domainConfig: DomainConfig): string {
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
    `3. If both fail, respond with: "${ADMIN_FALLBACK_MESSAGE_PREFIX} Please check: ${fallbackUrl}."\n\n` +
    `Grounding & citations\n` +
    `- Only synthesize from retrieved sources.\n` +
    `- Keep product names, ingredient names, dosage language, and direct claims exact when quoting from sources.\n` +
    `- For normal narrative prose, correct obvious spelling or spacing errors while preserving meaning.\n` +
    `- If spelling appears inconsistent across sources, quote the exact source phrase and note the discrepancy.\n` +
    `- Always include a Sources section listing exact URLs (or document titles + canonical_id for files).\n\n` +
    `Image handling\n` +
    `- If the user uploads images, inspect them first. Extract visible text (product names, claims, numbers) and describe notable visual details.\n` +
    `- Use insights from the images to drive any necessary web_search or file_search calls so you can cite on-domain evidence. If you cannot corroborate an image-derived fact, say so explicitly.\n\n` +
    `Domain selection heuristics\n` +
    `- Default to "site:${stripScheme(primary)}" in web_search queries.\n` +
    secondaryDirective +
    `- Never use broader web results for Melaleuca or Riverbend topics. If no allowlisted sources resolve the question, fall back.\n\n` +
    `Formatting\n` +
    `- Keep answers concise.\n` +
    `- Include effective dates when the source provides them.\n` +
    `- Your final message must end with a section that begins with "Sources:" on its own line, followed by bullet links to every cited source. Do not respond without this section.`;
}

function buildCsrSystemPrompt(domainConfig: DomainConfig): string {
  const [primary, secondary] = domainConfig.preferredDomains;
  const siteDirectives = domainConfig.preferredDomains
    .map((domain, index) => `${index + 1}. ${domain}`)
    .join('\n');
  const secondaryDirective = secondary
    ? `- If that fails and you have a second domain, try it next using "site:${stripScheme(secondary)}".\n`
    : '';

  return `You are Melaleuca's customer service knowledge assistant. Use the language and tone of official Melaleuca materials while delivering a world-class customer experience: warm, professional, respectful, and efficient.\n\n` +
    `Responses must follow this structure every time\n` +
    `1. Start with concise bullet points summarizing key answer(s) and actions.\n` +
    `2. Follow with clear step-by-step details and guidance, including appropriate phrasing for calls.\n` +
    `3. End with a short list of verified resources (titles and links or identifiers).\n\n` +
    `Retrieval and verification\n` +
    `1. Use web_search first. Prefer results from these domains, in order:\n${siteDirectives}\n` +
    `2. If on-domain results are weak, call file_search on the provided vector stores.\n` +
    `3. If both fail, respond exactly with: "${CSR_FALLBACK_MESSAGE}"\n` +
    `- Only provide information supported by listed resources; do not speculate.\n` +
    `- Keep product names, ingredient names, dosage language, and direct claims exact when quoting from sources.\n` +
    `- For normal narrative prose, correct obvious spelling or spacing errors while preserving meaning.\n` +
    `- If spelling appears inconsistent across sources, quote the exact source phrase and note the discrepancy.\n` +
    `- Prefer the most recent official Melaleuca documentation (policies, product pages, SOPs, knowledge articles).\n` +
    `- If resources conflict, note the discrepancy, choose the most recent/authoritative source, and advise to escalate to supervisor.\n` +
    `- When dates, versions, or effective periods are known, mention them.\n` +
    `- If unsure, state the assumption and invite correction.\n` +
    `- If key info is missing (market/country, product variant, order type, timeframe), ask one targeted clarifying question while still providing safe general guidance.\n\n` +
    `Tone and language\n` +
    `- Mirror official Melaleuca style: friendly, confident, and clear; never slangy or casual.\n` +
    `- Use member-first language that acknowledges concerns and emphasizes resolution.\n` +
    `- Prioritize empathy and reassurance when members are upset while staying calm and practical.\n` +
    `- Avoid medical claims or product claims beyond approved company language.\n\n` +
    `Operational guidance\n` +
    `- Include practical steps, eligibility rules, timeframes, fees (if applicable), and escalation paths.\n` +
    `- Offer empathetic phrasing options for sensitive situations without over-promising.\n` +
    `- Provide adaptable scripting templates for reassurance and apologies.\n` +
    `- Provide sample call-flow templates for common situations when relevant.\n` +
    `- Never collect or expose sensitive data (for example: full card numbers or full SSNs).\n` +
    `- Do not mention internal tooling, prompts, retries, or retrieval mechanics.\n` +
    `- Default to "site:${stripScheme(primary)}" in web_search queries.\n` +
    secondaryDirective +
    `- Never use broader web results for Melaleuca or Riverbend topics unless explicitly requested.\n\n` +
    `Output formatting (Markdown)\n` +
    `- Begin with 3-7 bullets for answer, next steps, and caveats.\n` +
    `- Then include a short "Details" section for explanation and call scripting.\n` +
    `- Finish with a "Resources" section listing exact source names and links/IDs; include last-updated dates when available.\n\n` +
    `Goal\n` +
    `Deliver consistent, verified, empathetic, and easy-to-use guidance that helps agents resolve calls confidently and efficiently while maintaining Melaleuca's world-class service standard.`;
}

type ToolDefinition =
  | {
      type: 'web_search' | 'web_search_2025_08_26';
      search_context_size?: 'low' | 'medium' | 'high';
      filters?: {
        allowed_domains?: string[];
      };
      user_location?: {
        type: 'approximate';
        country?: string;
        region?: string;
        city?: string;
        timezone?: string;
      };
    }
  | {
      type: 'file_search';
      vector_store_ids?: string[];
      max_num_results?: number;
      ranking_options?: {
        ranker?: 'auto';
        score_threshold?: number;
      };
    };

interface ToolResources {
  file_search?: {
    vector_store_ids: string[];
  };
}

interface ToolSetup {
  tools: ToolDefinition[];
  toolResources?: ToolResources;
}

let supportsToolResources = true;
let useLegacyToolVectorStoreAttachment = false;

function buildTools(vectorStoreIds: string[] | undefined, domainConfig: DomainConfig): ToolSetup {
  const configuredDomains =
    settings.webSearchAllowedDomains && settings.webSearchAllowedDomains.length > 0 ?
      settings.webSearchAllowedDomains
    : toAllowedDomains(domainConfig.preferredDomains);
  const allowedDomains = tightenMelaleucaSearchHosts(configuredDomains);
  const userLocation = buildUserLocation();
  const tools: ToolDefinition[] = [
    {
      type: 'web_search',
      search_context_size: 'medium',
      ...(allowedDomains.length > 0 ? { filters: { allowed_domains: allowedDomains } } : {}),
      ...(userLocation ? { user_location: userLocation } : {}),
    },
  ];

  const stores = vectorStoreIds ?? settings.vectorStoreIds;
  const toolResources: ToolResources | undefined =
    stores.length > 0
      ? {
          file_search: {
            vector_store_ids: stores,
          },
        }
      : undefined;

  if (toolResources?.file_search) {
    const fileSearchTool: ToolDefinition = {
      type: 'file_search',
      max_num_results: 5,
      ranking_options: {
        ranker: 'auto',
        score_threshold: settings.fileSearchScoreThreshold,
      },
    };

    if (useLegacyToolVectorStoreAttachment) {
      fileSearchTool.vector_store_ids = toolResources.file_search.vector_store_ids;
    }

    tools.push(fileSearchTool);
  }

  return { tools, toolResources };
}

function isUnknownToolResourcesError(error: unknown): boolean {
  if (!(error instanceof OpenAI.BadRequestError)) {
    return false;
  }

  const message = error.message ?? '';
  if (typeof message !== 'string') {
    return false;
  }

  return message.includes("Unknown parameter: 'tool_resources'");
}

async function createResponseWithTools(
  requestBase: Record<string, unknown>,
  setup: ToolSetup,
  includeToolResources: boolean,
): Promise<Response> {
  const payload: Record<string, unknown> = {
    ...requestBase,
    tools: setup.tools,
  };

  if (includeToolResources && setup.toolResources) {
    payload.tool_resources = setup.toolResources as unknown;
  }

  return client.responses.create(payload as any);
}

async function createResponseWithCompatibilityFallback(
  requestBase: Record<string, unknown>,
  setup: ToolSetup,
  vectorStoreIds: string[] | undefined,
  domainConfig: DomainConfig,
): Promise<Response> {
  try {
    return await createResponseWithTools(requestBase, setup, supportsToolResources);
  } catch (error) {
    if (supportsToolResources && setup.toolResources && isUnknownToolResourcesError(error)) {
      console.warn('Responses API does not accept tool_resources. Falling back to legacy vector store attachment.');
      supportsToolResources = false;
      useLegacyToolVectorStoreAttachment = true;

      const legacySetup = buildTools(vectorStoreIds, domainConfig);
      return createResponseWithTools(requestBase, legacySetup, supportsToolResources);
    }
    throw error;
  }
}

interface StreamPassResult {
  response: Response;
  streamedChars: number;
  timeToFirstDeltaMs?: number;
}

async function createStreamedResponseWithTools(
  requestBase: Record<string, unknown>,
  setup: ToolSetup,
  includeToolResources: boolean,
  onDelta?: (delta: string) => void,
): Promise<StreamPassResult> {
  const streamStartMs = Date.now();
  let timeToFirstDeltaMs: number | undefined;
  let streamedChars = 0;

  const payload: Record<string, unknown> = {
    ...requestBase,
    tools: setup.tools,
    stream: true,
  };

  if (includeToolResources && setup.toolResources) {
    payload.tool_resources = setup.toolResources as unknown;
  }

  const stream = client.responses.stream(payload as any);
  for await (const event of stream) {
    if (event.type !== 'response.output_text.delta' || typeof event.delta !== 'string' || event.delta.length === 0) {
      continue;
    }

    if (timeToFirstDeltaMs == null) {
      timeToFirstDeltaMs = Date.now() - streamStartMs;
    }
    streamedChars += event.delta.length;
    onDelta?.(event.delta);
  }

  const response = await stream.finalResponse();
  return {
    response,
    streamedChars,
    timeToFirstDeltaMs,
  };
}

async function createStreamedResponseWithCompatibilityFallback(
  requestBase: Record<string, unknown>,
  setup: ToolSetup,
  vectorStoreIds: string[] | undefined,
  domainConfig: DomainConfig,
  onDelta?: (delta: string) => void,
): Promise<StreamPassResult> {
  try {
    return await createStreamedResponseWithTools(requestBase, setup, supportsToolResources, onDelta);
  } catch (error) {
    if (supportsToolResources && setup.toolResources && isUnknownToolResourcesError(error)) {
      console.warn('Responses API does not accept tool_resources. Falling back to legacy vector store attachment.');
      supportsToolResources = false;
      useLegacyToolVectorStoreAttachment = true;

      const legacySetup = buildTools(vectorStoreIds, domainConfig);
      return createStreamedResponseWithTools(requestBase, legacySetup, supportsToolResources, onDelta);
    }
    throw error;
  }
}

function hasFileSearchTool(setup: ToolSetup): boolean {
  return setup.tools.some((tool) => tool.type === 'file_search');
}

function isSourceFallbackAnswer(answer: string): boolean {
  return (
    new RegExp(`^${escapeRegExp(ADMIN_FALLBACK_MESSAGE_PREFIX)}`, 'i').test(answer.trim()) ||
    new RegExp(`^${escapeRegExp(CSR_FALLBACK_MESSAGE)}$`, 'i').test(answer.trim())
  );
}

function buildRetryUserContent(userContent: ResponseInputMessageContentList): ResponseInputMessageContentList {
  return userContent.map((piece) => {
    if (piece.type !== 'input_text') {
      return piece;
    }

    return {
      ...piece,
      text:
        `${piece.text}\n\n` +
        'Retry instruction: The previous attempt could not confirm an allowlisted source. ' +
        'Call file_search first on the provided vector store before finalizing. ' +
        'Use web_search only if file_search is insufficient. ' +
        'Return a concise answer with a Sources section citing exact file names or URLs.',
    };
  });
}

function buildCsrRetryUserContent(userContent: ResponseInputMessageContentList): ResponseInputMessageContentList {
  return userContent.map((piece) => {
    if (piece.type !== 'input_text') {
      return piece;
    }

    return {
      ...piece,
      text:
        `${piece.text}\n\n` +
        'Retry instruction: The previous attempt lacked verified US sources. ' +
        'Run web_search again with strict US bias. ' +
        'Prefer www.melaleuca.com pages and cdnsc1.melaleuca.com/na/ documents only. ' +
        'Ignore non-US locale pages and non-US subdomains. ' +
        'If no US-verified source is found, respond exactly with "No verified sources found."',
    };
  });
}

function shouldEvaluateAnswerQuality(model: string): boolean {
  if (!ENABLE_ANSWER_QUALITY_RETRY) {
    return false;
  }

  if (QUALITY_RETRY_MODEL_PREFIXES.length === 0) {
    return true;
  }

  const normalizedModel = model.trim().toLowerCase();
  return QUALITY_RETRY_MODEL_PREFIXES.some((prefix) => normalizedModel.startsWith(prefix));
}

function parseQualityCheckResult(value: string): { needsRetry: boolean; reason: string; suspiciousTokens: string[] } {
  const fallback = { needsRetry: false, reason: 'quality_check_parse_failed', suspiciousTokens: [] as string[] };
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  try {
    const cleaned = stripMarkdownCodeFence(trimmed);
    const data = JSON.parse(cleaned) as {
      needs_retry?: unknown;
      reason?: unknown;
      suspicious_tokens?: unknown;
    };
    const needsRetry = data.needs_retry === true;
    const reason = typeof data.reason === 'string' && data.reason.trim().length > 0 ? data.reason.trim() : fallback.reason;
    const suspiciousTokens =
      Array.isArray(data.suspicious_tokens) ?
        data.suspicious_tokens.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    return { needsRetry, reason, suspiciousTokens };
  } catch {
    return fallback;
  }
}

async function detectAnswerCorruption(answer: string): Promise<{ needsRetry: boolean; reason: string }> {
  const text = answer.trim();
  if (!text || isSourceFallbackAnswer(text)) {
    return { needsRetry: false, reason: 'fallback_or_empty' };
  }

  try {
    const response = await client.responses.create(
      {
        model: QUALITY_CHECK_MODEL,
        max_output_tokens: 160,
        text: {
          format: {
            type: 'json_schema',
            json_schema: ANSWER_QUALITY_CHECK_SCHEMA,
          },
        },
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text:
                  'You are a strict QA checker for assistant responses. ' +
                  'Set needs_retry=true if there is any likely typo corruption, including clipped words, dropped letters, fused words, or malformed fragments. ' +
                  'Be strict: one suspicious token is enough to require retry. ' +
                  'Ignore normal style choices, trademarks, markdown, URLs, and brand names.',
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text:
                  'Evaluate this answer for typo corruption.\n\n' +
                  'Answer:\n' +
                  text,
              },
            ],
          },
        ],
      } as any,
    );

    const parsed = parseQualityCheckResult(normalizeAnswer(response));
    return {
      needsRetry: parsed.needsRetry || parsed.suspiciousTokens.length > 0,
      reason:
        parsed.suspiciousTokens.length > 0 ?
          `${parsed.reason} | tokens: ${parsed.suspiciousTokens.join(', ')}`
        : parsed.reason,
    };
  } catch (error) {
    console.warn('Quality check failed:', error);
    return { needsRetry: false, reason: 'quality_check_error' };
  }
}

async function rewriteAnswerForQuality(
  answer: string,
  model: string,
): Promise<string> {
  const rewriteModel = QUALITY_REWRITE_MODEL || model;
  const response = await client.responses.create(
    {
      model: rewriteModel,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
                'You are a copy editor for a grounded support answer. ' +
                'Fix only obvious spelling, spacing, and clipped-word errors. ' +
                'Do not add or remove claims, numbers, products, URLs, or citations. ' +
                'Preserve markdown structure and keep the Sources section.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Clean this answer while preserving meaning and citations exactly:\n\n${answer}`,
            },
          ],
        },
      ],
    } as any,
  );

  return normalizeAnswer(response).trim();
}

function extractSourcesSection(answer: string): string | null {
  const match = /(^|\n)\s*Sources\s*:/i.exec(answer);
  if (!match) {
    return null;
  }
  return answer.slice(match.index).trim();
}

function stripSourcesSection(answer: string): string {
  const match = /(^|\n)\s*Sources\s*:/i.exec(answer);
  if (!match) {
    return answer.trim();
  }
  return answer.slice(0, match.index).trim();
}

function preserveSourcesSection(cleanedAnswer: string, originalAnswer: string): string {
  const originalSources = extractSourcesSection(originalAnswer);
  if (!originalSources) {
    return cleanedAnswer;
  }

  const prefix = stripSourcesSection(cleanedAnswer);
  if (!prefix) {
    return originalAnswer;
  }

  return `${prefix}\n\n${originalSources}`;
}

function toPreview(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, Math.max(40, MAX_DEBUG_PREVIEW_CHARS));
}

function extractFileSearchResultPreview(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  const item = result as Record<string, unknown>;
  const direct =
    toPreview(item.text) ??
    toPreview(item.content) ??
    toPreview((item.chunk as Record<string, unknown> | undefined)?.text) ??
    toPreview((item.document as Record<string, unknown> | undefined)?.text);
  if (direct) {
    return direct;
  }

  if (Array.isArray(item.content)) {
    const joined = item.content
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return '';
        }
        const typed = entry as Record<string, unknown>;
        return toPreview(typed.text) ?? '';
      })
      .filter((entry) => entry.length > 0)
      .join(' ');
    return toPreview(joined);
  }

  return undefined;
}

function buildRetrievalDebugSummary(response: Response): {
  webSearchCalls: Array<{ sourceCount: number; sources: Array<{ title?: string; url?: string }> }>;
  fileSearchCalls: Array<{ resultCount: number; results: Array<{ file?: string; score?: number; snippet?: string }> }>;
  sourceEntries: string[];
} {
  const webSearchCalls: Array<{ sourceCount: number; sources: Array<{ title?: string; url?: string }> }> = [];
  const fileSearchCalls: Array<{ resultCount: number; results: Array<{ file?: string; score?: number; snippet?: string }> }> = [];

  for (const outputItem of response.output ?? []) {
    if (!outputItem || typeof outputItem !== 'object') {
      continue;
    }

    const item = outputItem as unknown as Record<string, unknown>;
    const type = String(item.type ?? '');

    if (type.includes('web_search_call')) {
      const rawSources = ((item.action as Record<string, unknown> | undefined)?.sources ?? []) as unknown[];
      const sources = rawSources
        .slice(0, Math.max(1, MAX_DEBUG_ITEMS))
        .map((source) => {
          if (!source || typeof source !== 'object') {
            return {};
          }
          const typed = source as Record<string, unknown>;
          return {
            title: typeof typed.title === 'string' ? typed.title : undefined,
            url: typeof typed.url === 'string' ? typed.url : undefined,
          };
        });

      webSearchCalls.push({
        sourceCount: Array.isArray(rawSources) ? rawSources.length : 0,
        sources,
      });
      continue;
    }

    if (type.includes('file_search_call')) {
      const rawResults = (item.results ?? []) as unknown[];
      const results = rawResults.slice(0, Math.max(1, MAX_DEBUG_ITEMS)).map((result) => {
        const typed = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
        const file =
          (typeof typed.filename === 'string' && typed.filename) ||
          (typeof typed.file_id === 'string' && typed.file_id) ||
          (typeof typed.document_id === 'string' && typed.document_id) ||
          undefined;
        const score = typeof typed.score === 'number' ? typed.score : undefined;
        const snippet = extractFileSearchResultPreview(result);
        return { file, score, snippet };
      });

      fileSearchCalls.push({
        resultCount: Array.isArray(rawResults) ? rawResults.length : 0,
        results,
      });
    }
  }

  const sourceEntries = extractSourceEntries(normalizeAnswer(response)).slice(0, Math.max(1, MAX_DEBUG_ITEMS));
  return { webSearchCalls, fileSearchCalls, sourceEntries };
}

function maybeLogRetrievalDebug(params: {
  mode: 'ask' | 'ask_stream';
  agentProfile: AgentProfile;
  model: string;
  topic: TopicHint;
  message: string;
  finalAnswer: string;
  retries: AskRetryMetric[];
  response: Response;
}): void {
  if (!ENABLE_RETRIEVAL_DEBUG_LOGS) {
    return;
  }

  const summary = buildRetrievalDebugSummary(params.response);
  console.info(
    '[retrieval_debug]',
    JSON.stringify({
      mode: params.mode,
      agentProfile: params.agentProfile,
      model: params.model,
      topic: params.topic,
      messagePreview: toPreview(params.message),
      answerPreview: toPreview(params.finalAnswer),
      retries: params.retries,
      ...summary,
    }),
  );
}

type AnswerSelectionSource = 'output_text' | 'assistant_last' | 'first_message' | 'empty';

interface NormalizeAnswerSelection {
  answer: string;
  source: AnswerSelectionSource;
  outputText: string;
  assistantMessages: string[];
  firstMessage: string;
}

function clipAnswerDebugText(value: string): string {
  const limit = Number.isFinite(MAX_ANSWER_DEBUG_CHARS) ? Math.max(200, MAX_ANSWER_DEBUG_CHARS) : 12000;
  if (value.length <= limit) {
    return value;
  }
  const hidden = value.length - limit;
  return `${value.slice(0, limit)}\n...[truncated ${hidden} chars]`;
}

function maybeLogAnswerSelectionDebug(params: {
  mode: 'ask' | 'ask_stream';
  phase: 'initial' | 'admin_retry' | 'csr_retry';
  selection: NormalizeAnswerSelection;
  finalAnswer: string;
}): void {
  if (!ENABLE_ANSWER_SELECTION_DEBUG_LOGS) {
    return;
  }

  console.info(
    '[answer_selection_debug]',
    JSON.stringify({
      mode: params.mode,
      phase: params.phase,
      selectedSource: params.selection.source,
      assistantMessageCount: params.selection.assistantMessages.length,
      outputText: clipAnswerDebugText(params.selection.outputText),
      assistantMessages: params.selection.assistantMessages.map((entry) => clipAnswerDebugText(entry)),
      firstMessage: clipAnswerDebugText(params.selection.firstMessage),
      normalizedAnswer: clipAnswerDebugText(params.selection.answer),
      finalAnswer: clipAnswerDebugText(params.finalAnswer),
    }),
  );
}

function selectNormalizedAnswer(response: Response): NormalizeAnswerSelection {
  const outputText = typeof response.output_text === 'string' ? response.output_text.trim() : '';
  const assistantMessages = extractAssistantMessages(response);
  const firstMessage = extractFirstMessageText(response);

  if (outputText) {
    return {
      answer: outputText,
      source: 'output_text',
      outputText,
      assistantMessages,
      firstMessage,
    };
  }

  const lastMessage = assistantMessages[assistantMessages.length - 1];
  if (lastMessage) {
    return {
      answer: lastMessage,
      source: 'assistant_last',
      outputText,
      assistantMessages,
      firstMessage,
    };
  }

  if (firstMessage) {
    return {
      answer: firstMessage,
      source: 'first_message',
      outputText,
      assistantMessages,
      firstMessage,
    };
  }

  return {
    answer: '',
    source: 'empty',
    outputText,
    assistantMessages,
    firstMessage,
  };
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

function extractAssistantMessages(response: Response): string[] {
  const messages: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type === 'message' && item.role === 'assistant') {
      const text = item.content
        .map((piece) => (piece.type === 'output_text' ? piece.text : ''))
        .join('\n')
        .trim();
      if (text.length > 0) {
        messages.push(text);
      }
    }
  }
  return messages;
}

export async function ask(params: AskParams): Promise<AskResult> {
  const askStartMs = Date.now();
  const message = params.message.trim();
  const hasImages = Array.isArray(params.images) && params.images.length > 0;
  if (!message && !hasImages) {
    throw new Error('Message or images must be provided');
  }

  const metrics: AskMetrics = {
    imageAnalysisMs: 0,
    initialResponseMs: 0,
    retries: [],
    totalMs: 0,
  };

  const topic = params.topicHint ?? inferTopicHint(message);
  const agentProfile = params.agentProfile ?? 'admin';
  const domainConfig = buildDomainConfig(topic);
  const model = params.model ?? settings.model;
  const toolSetup = buildTools(params.vectorStoreIds, domainConfig);
  const systemPrompt = buildSystemPrompt(domainConfig, agentProfile);

  const imageAnalysisStartMs = Date.now();
  const imageInsights = hasImages ? await extractImageInsights(params.images ?? [], topic) : [];
  metrics.imageAnalysisMs = Date.now() - imageAnalysisStartMs;
  const historyTranscript = params.previousResponseId ? null : formatHistory(params.history ?? []);
  const userText = message.length > 0 ? message : 'Please review the attached image(s) and provide your findings.';

  const userContent: ResponseInputMessageContentList = [
    {
      type: 'input_text',
      text: buildUserMessage(userText, domainConfig, historyTranscript, params.images, imageInsights),
    },
  ];

  for (const image of params.images ?? []) {
    userContent.push({
      type: 'input_image',
      detail: 'high',
      image_url: `data:${image.mimeType};base64,${image.data}`,
    });
  }

  const buildRequestBase = (
    content: ResponseInputMessageContentList,
    metadataExtras?: Record<string, string>,
  ) => {
    return (
    ({
      model,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      include: ['web_search_call.action.sources', 'file_search_call.results'],
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
          content,
        },
      ],
      metadata: {
        topic_hint: topic,
        primary_domain: domainConfig.preferredDomains[0],
        agent_profile: agentProfile,
        ...(metadataExtras ?? {}),
      },
      ...(params.reasoningEffort ? { reasoning: { effort: params.reasoningEffort } } : {}),
      ...(params.previousResponseId ? { previous_response_id: params.previousResponseId } : {}),
    }) as const
    );
  };

  const requestBase = buildRequestBase(userContent);

  const initialResponseStartMs = Date.now();
  params.onProgress?.({ stage: 'initial_response_start' });
  let response = await createResponseWithCompatibilityFallback(
    requestBase,
    toolSetup,
    params.vectorStoreIds,
    domainConfig,
  );
  metrics.initialResponseMs = Date.now() - initialResponseStartMs;
  params.onProgress?.({ stage: 'initial_response_complete' });

  const initialSelection = selectNormalizedAnswer(response);
  let answerWithSources = ensureSourcesSection(initialSelection.answer, params.images);
  let finalAnswer = enforceSourceAllowlist(answerWithSources, domainConfig, agentProfile, response, params.images, imageInsights);
  maybeLogAnswerSelectionDebug({ mode: 'ask', phase: 'initial', selection: initialSelection, finalAnswer });
  if (!hasSourcesSection(answerWithSources)) {
    console.warn('Model response missing Sources section.');
  }

  if (agentProfile === 'admin' && isSourceFallbackAnswer(finalAnswer) && hasFileSearchTool(toolSetup)) {
    const retryMetric: AskRetryMetric = {
      reason: 'admin_source_fallback',
      attempted: false,
      succeeded: false,
    };
    metrics.retries.push(retryMetric);
    const retryContent = buildRetryUserContent(userContent);
    const retryRequestBase = buildRequestBase(retryContent, { retry_after_source_fallback: '1' });
    const retryStartMs = Date.now();
    params.onProgress?.({ stage: 'admin_retry_start' });

    try {
      retryMetric.attempted = true;
      const retrySetup = buildTools(params.vectorStoreIds, domainConfig);
      const retryResponse = await createResponseWithCompatibilityFallback(
        retryRequestBase,
        retrySetup,
        params.vectorStoreIds,
        domainConfig,
      );
      const retrySelection = selectNormalizedAnswer(retryResponse);
      const retryAnswerWithSources = ensureSourcesSection(retrySelection.answer, params.images);
      const retryFinalAnswer = enforceSourceAllowlist(
        retryAnswerWithSources,
        domainConfig,
        agentProfile,
        retryResponse,
        params.images,
        imageInsights,
      );
      maybeLogAnswerSelectionDebug({ mode: 'ask', phase: 'admin_retry', selection: retrySelection, finalAnswer: retryFinalAnswer });

      if (!hasSourcesSection(retryAnswerWithSources)) {
        console.warn('Model retry response missing Sources section.');
      }

      response = retryResponse;
      answerWithSources = retryAnswerWithSources;
      finalAnswer = retryFinalAnswer;
      retryMetric.succeeded = true;
      retryMetric.durationMs = Date.now() - retryStartMs;
      params.onProgress?.({ stage: 'admin_retry_complete' });
    } catch (error) {
      retryMetric.durationMs = Date.now() - retryStartMs;
      console.warn('Retry after source fallback failed:', error);
      params.onProgress?.({ stage: 'admin_retry_complete' });
    }
  }

  if (agentProfile === 'csr' && isSourceFallbackAnswer(finalAnswer)) {
    const retryMetric: AskRetryMetric = {
      reason: 'csr_source_fallback',
      attempted: false,
      succeeded: false,
    };
    metrics.retries.push(retryMetric);
    const retryContent = buildCsrRetryUserContent(userContent);
    const retryRequestBase = buildRequestBase(retryContent, { retry_after_csr_us_fallback: '1' });
    const retryStartMs = Date.now();
    params.onProgress?.({ stage: 'csr_retry_start' });

    try {
      retryMetric.attempted = true;
      const retrySetup = buildTools(params.vectorStoreIds, domainConfig);
      const retryResponse = await createResponseWithCompatibilityFallback(
        retryRequestBase,
        retrySetup,
        params.vectorStoreIds,
        domainConfig,
      );
      const retrySelection = selectNormalizedAnswer(retryResponse);
      const retryAnswerWithSources = ensureSourcesSection(retrySelection.answer, params.images);
      const retryFinalAnswer = enforceSourceAllowlist(
        retryAnswerWithSources,
        domainConfig,
        agentProfile,
        retryResponse,
        params.images,
        imageInsights,
      );
      maybeLogAnswerSelectionDebug({ mode: 'ask', phase: 'csr_retry', selection: retrySelection, finalAnswer: retryFinalAnswer });

      if (!hasSourcesSection(retryAnswerWithSources)) {
        console.warn('Model CSR retry response missing Sources section.');
      }

      response = retryResponse;
      answerWithSources = retryAnswerWithSources;
      finalAnswer = retryFinalAnswer;
      retryMetric.succeeded = true;
      retryMetric.durationMs = Date.now() - retryStartMs;
      params.onProgress?.({ stage: 'csr_retry_complete' });
    } catch (error) {
      retryMetric.durationMs = Date.now() - retryStartMs;
      console.warn('CSR retry after US source fallback failed:', error);
      params.onProgress?.({ stage: 'csr_retry_complete' });
    }
  }

  if (shouldEvaluateAnswerQuality(model) && !isSourceFallbackAnswer(finalAnswer)) {
    const qualityRetryMetric: AskRetryMetric = {
      reason: 'quality_cleanup',
      attempted: false,
      succeeded: false,
    };
    const qualityCheck =
      FORCE_ANSWER_QUALITY_REWRITE ?
        { needsRetry: true, reason: 'forced_quality_rewrite' }
      : await detectAnswerCorruption(finalAnswer);

    if (qualityCheck.needsRetry) {
      metrics.retries.push(qualityRetryMetric);
      qualityRetryMetric.attempted = true;
      const retryStartMs = Date.now();
      params.onProgress?.({ stage: 'quality_retry_start' });

      try {
        const rewritten = await rewriteAnswerForQuality(finalAnswer, model);
        if (rewritten) {
          const withSources = preserveSourcesSection(ensureSourcesSection(rewritten, params.images), finalAnswer);
          const effectiveAllowedDomains = getEffectiveAllowedDomains(domainConfig);
          const sanitized = stripDisallowedUrlLines(withSources, effectiveAllowedDomains);
          finalAnswer = sanitized.trim().length > 0 ? sanitized : finalAnswer;
        }
        qualityRetryMetric.succeeded = true;
        qualityRetryMetric.durationMs = Date.now() - retryStartMs;
      } catch (error) {
        qualityRetryMetric.durationMs = Date.now() - retryStartMs;
        console.warn(`Quality cleanup retry failed (${qualityCheck.reason}):`, error);
      } finally {
        params.onProgress?.({ stage: 'quality_retry_complete' });
      }
    }
  }

  metrics.totalMs = Date.now() - askStartMs;
  maybeLogRetrievalDebug({
    mode: 'ask',
    agentProfile,
    model,
    topic,
    message,
    finalAnswer,
    retries: metrics.retries,
    response,
  });
  params.onProgress?.({ stage: 'done' });

  return {
    answer: finalAnswer,
    response,
    metrics,
  };
}

export async function askStream(params: AskStreamParams): Promise<AskStreamResult> {
  const askStartMs = Date.now();
  const message = params.message.trim();
  const hasImages = Array.isArray(params.images) && params.images.length > 0;
  if (!message && !hasImages) {
    throw new Error('Message or images must be provided');
  }

  const metrics: AskMetrics = {
    imageAnalysisMs: 0,
    initialResponseMs: 0,
    retries: [],
    totalMs: 0,
  };

  const streamMetrics: AskStreamMetrics = {
    draftRevisionCount: 0,
    streamedCharsPass1: 0,
    streamedCharsPass2: 0,
  };

  const topic = params.topicHint ?? inferTopicHint(message);
  const agentProfile = params.agentProfile ?? 'admin';
  const domainConfig = buildDomainConfig(topic);
  const model = params.model ?? settings.model;
  const toolSetup = buildTools(params.vectorStoreIds, domainConfig);
  const systemPrompt = buildSystemPrompt(domainConfig, agentProfile);

  const imageAnalysisStartMs = Date.now();
  const imageInsights = hasImages ? await extractImageInsights(params.images ?? [], topic) : [];
  metrics.imageAnalysisMs = Date.now() - imageAnalysisStartMs;
  const historyTranscript = params.previousResponseId ? null : formatHistory(params.history ?? []);
  const userText = message.length > 0 ? message : 'Please review the attached image(s) and provide your findings.';

  const userContent: ResponseInputMessageContentList = [
    {
      type: 'input_text',
      text: buildUserMessage(userText, domainConfig, historyTranscript, params.images, imageInsights),
    },
  ];

  for (const image of params.images ?? []) {
    userContent.push({
      type: 'input_image',
      detail: 'high',
      image_url: `data:${image.mimeType};base64,${image.data}`,
    });
  }

  const buildRequestBase = (
    content: ResponseInputMessageContentList,
    metadataExtras?: Record<string, string>,
  ) => {
    return (
    ({
      model,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      include: ['web_search_call.action.sources', 'file_search_call.results'],
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
          content,
        },
      ],
      metadata: {
        topic_hint: topic,
        primary_domain: domainConfig.preferredDomains[0],
        agent_profile: agentProfile,
        ...(metadataExtras ?? {}),
      },
      ...(params.reasoningEffort ? { reasoning: { effort: params.reasoningEffort } } : {}),
      ...(params.previousResponseId ? { previous_response_id: params.previousResponseId } : {}),
    }) as const
    );
  };

  const requestBase = buildRequestBase(userContent);
  let activeDraftId = 'draft_1';

  const initialResponseStartMs = Date.now();
  params.onProgress?.({ stage: 'initial_response_start' });
  let initialPass = await createStreamedResponseWithCompatibilityFallback(
    requestBase,
    toolSetup,
    params.vectorStoreIds,
    domainConfig,
    (delta) => {
      if (streamMetrics.timeToFirstDeltaMs == null) {
        streamMetrics.timeToFirstDeltaMs = Date.now() - askStartMs;
      }
      params.onDraftDelta?.({ draftId: activeDraftId, text: delta });
    },
  );
  metrics.initialResponseMs = Date.now() - initialResponseStartMs;
  streamMetrics.streamedCharsPass1 = initialPass.streamedChars;
  params.onProgress?.({ stage: 'initial_response_complete' });

  let response = initialPass.response;
  const initialSelection = selectNormalizedAnswer(response);
  let answerWithSources = ensureSourcesSection(initialSelection.answer, params.images);
  let finalAnswer = enforceSourceAllowlist(answerWithSources, domainConfig, agentProfile, response, params.images, imageInsights);
  maybeLogAnswerSelectionDebug({ mode: 'ask_stream', phase: 'initial', selection: initialSelection, finalAnswer });
  if (!hasSourcesSection(answerWithSources)) {
    console.warn('Model response missing Sources section.');
  }

  if (agentProfile === 'admin' && isSourceFallbackAnswer(finalAnswer) && hasFileSearchTool(toolSetup)) {
    const retryMetric: AskRetryMetric = {
      reason: 'admin_source_fallback',
      attempted: false,
      succeeded: false,
    };
    metrics.retries.push(retryMetric);
    const retryContent = buildRetryUserContent(userContent);
    const retryRequestBase = buildRequestBase(retryContent, { retry_after_source_fallback: '1' });
    const retryStartMs = Date.now();
    params.onProgress?.({ stage: 'admin_retry_start' });

    try {
      retryMetric.attempted = true;
      const retrySetup = buildTools(params.vectorStoreIds, domainConfig);
      const nextDraftId = 'draft_2';
      streamMetrics.draftRevisionCount += 1;
      params.onDraftRevision?.({ fromDraftId: activeDraftId, toDraftId: nextDraftId, reason: 'source_retry' });
      activeDraftId = nextDraftId;

      const retryPass = await createStreamedResponseWithCompatibilityFallback(
        retryRequestBase,
        retrySetup,
        params.vectorStoreIds,
        domainConfig,
        (delta) => {
          if (streamMetrics.timeToFirstDeltaMs == null) {
            streamMetrics.timeToFirstDeltaMs = Date.now() - askStartMs;
          }
          params.onDraftDelta?.({ draftId: activeDraftId, text: delta });
        },
      );
      streamMetrics.streamedCharsPass2 = retryPass.streamedChars;

      const retryResponse = retryPass.response;
      const retrySelection = selectNormalizedAnswer(retryResponse);
      const retryAnswerWithSources = ensureSourcesSection(retrySelection.answer, params.images);
      const retryFinalAnswer = enforceSourceAllowlist(
        retryAnswerWithSources,
        domainConfig,
        agentProfile,
        retryResponse,
        params.images,
        imageInsights,
      );
      maybeLogAnswerSelectionDebug({ mode: 'ask_stream', phase: 'admin_retry', selection: retrySelection, finalAnswer: retryFinalAnswer });

      if (!hasSourcesSection(retryAnswerWithSources)) {
        console.warn('Model retry response missing Sources section.');
      }

      response = retryResponse;
      answerWithSources = retryAnswerWithSources;
      finalAnswer = retryFinalAnswer;
      retryMetric.succeeded = true;
      retryMetric.durationMs = Date.now() - retryStartMs;
      params.onProgress?.({ stage: 'admin_retry_complete' });
    } catch (error) {
      retryMetric.durationMs = Date.now() - retryStartMs;
      console.warn('Retry after source fallback failed:', error);
      params.onProgress?.({ stage: 'admin_retry_complete' });
    }
  }

  if (agentProfile === 'csr' && isSourceFallbackAnswer(finalAnswer)) {
    const retryMetric: AskRetryMetric = {
      reason: 'csr_source_fallback',
      attempted: false,
      succeeded: false,
    };
    metrics.retries.push(retryMetric);
    const retryContent = buildCsrRetryUserContent(userContent);
    const retryRequestBase = buildRequestBase(retryContent, { retry_after_csr_us_fallback: '1' });
    const retryStartMs = Date.now();
    params.onProgress?.({ stage: 'csr_retry_start' });

    try {
      retryMetric.attempted = true;
      const retrySetup = buildTools(params.vectorStoreIds, domainConfig);
      const nextDraftId = activeDraftId === 'draft_1' ? 'draft_2' : 'draft_3';
      streamMetrics.draftRevisionCount += 1;
      params.onDraftRevision?.({ fromDraftId: activeDraftId, toDraftId: nextDraftId, reason: 'source_retry' });
      activeDraftId = nextDraftId;

      const retryPass = await createStreamedResponseWithCompatibilityFallback(
        retryRequestBase,
        retrySetup,
        params.vectorStoreIds,
        domainConfig,
        (delta) => {
          if (streamMetrics.timeToFirstDeltaMs == null) {
            streamMetrics.timeToFirstDeltaMs = Date.now() - askStartMs;
          }
          params.onDraftDelta?.({ draftId: activeDraftId, text: delta });
        },
      );
      streamMetrics.streamedCharsPass2 = retryPass.streamedChars;

      const retryResponse = retryPass.response;
      const retrySelection = selectNormalizedAnswer(retryResponse);
      const retryAnswerWithSources = ensureSourcesSection(retrySelection.answer, params.images);
      const retryFinalAnswer = enforceSourceAllowlist(
        retryAnswerWithSources,
        domainConfig,
        agentProfile,
        retryResponse,
        params.images,
        imageInsights,
      );
      maybeLogAnswerSelectionDebug({ mode: 'ask_stream', phase: 'csr_retry', selection: retrySelection, finalAnswer: retryFinalAnswer });

      if (!hasSourcesSection(retryAnswerWithSources)) {
        console.warn('Model CSR retry response missing Sources section.');
      }

      response = retryResponse;
      answerWithSources = retryAnswerWithSources;
      finalAnswer = retryFinalAnswer;
      retryMetric.succeeded = true;
      retryMetric.durationMs = Date.now() - retryStartMs;
      params.onProgress?.({ stage: 'csr_retry_complete' });
    } catch (error) {
      retryMetric.durationMs = Date.now() - retryStartMs;
      console.warn('CSR retry after US source fallback failed:', error);
      params.onProgress?.({ stage: 'csr_retry_complete' });
    }
  }

  if (
    isSourceFallbackAnswer(finalAnswer) &&
    finalAnswer.trim() !== answerWithSources.trim() &&
    (streamMetrics.streamedCharsPass1 > 0 || streamMetrics.streamedCharsPass2 > 0)
  ) {
    streamMetrics.draftRevisionCount += 1;
    params.onDraftRevision?.({
      fromDraftId: activeDraftId,
      toDraftId: 'draft_final',
      reason: 'allowlist_replace',
    });
  }

  if (shouldEvaluateAnswerQuality(model) && !isSourceFallbackAnswer(finalAnswer)) {
    const qualityRetryMetric: AskRetryMetric = {
      reason: 'quality_cleanup',
      attempted: false,
      succeeded: false,
    };
    const qualityCheck =
      FORCE_ANSWER_QUALITY_REWRITE ?
        { needsRetry: true, reason: 'forced_quality_rewrite' }
      : await detectAnswerCorruption(finalAnswer);

    if (qualityCheck.needsRetry) {
      metrics.retries.push(qualityRetryMetric);
      qualityRetryMetric.attempted = true;
      const retryStartMs = Date.now();
      params.onProgress?.({ stage: 'quality_retry_start' });

      const nextDraftId = activeDraftId === 'draft_final' ? 'draft_quality_2' : 'draft_quality';
      streamMetrics.draftRevisionCount += 1;
      params.onDraftRevision?.({ fromDraftId: activeDraftId, toDraftId: nextDraftId, reason: 'quality_retry' });
      activeDraftId = nextDraftId;

      try {
        const rewritten = await rewriteAnswerForQuality(finalAnswer, model);
        if (rewritten) {
          const withSources = preserveSourcesSection(ensureSourcesSection(rewritten, params.images), finalAnswer);
          const effectiveAllowedDomains = getEffectiveAllowedDomains(domainConfig);
          const sanitized = stripDisallowedUrlLines(withSources, effectiveAllowedDomains);
          finalAnswer = sanitized.trim().length > 0 ? sanitized : finalAnswer;
        }
        qualityRetryMetric.succeeded = true;
        qualityRetryMetric.durationMs = Date.now() - retryStartMs;
      } catch (error) {
        qualityRetryMetric.durationMs = Date.now() - retryStartMs;
        console.warn(`Quality cleanup retry failed (${qualityCheck.reason}):`, error);
      } finally {
        params.onProgress?.({ stage: 'quality_retry_complete' });
      }
    }
  }

  metrics.totalMs = Date.now() - askStartMs;
  maybeLogRetrievalDebug({
    mode: 'ask_stream',
    agentProfile,
    model,
    topic,
    message,
    finalAnswer,
    retries: metrics.retries,
    response,
  });
  params.onProgress?.({ stage: 'done' });

  return {
    answer: finalAnswer,
    response,
    metrics,
    streamMetrics,
  };
}

function normalizeAnswer(response: Response): string {
  return selectNormalizedAnswer(response).answer;
}

function buildUserMessage(
  message: string,
  domainConfig: DomainConfig,
  historyTranscript?: string | null,
  images?: AskImage[] | undefined,
  insights?: ImageInsight[] | undefined,
): string {
  const [primaryDomain, secondaryDomain] = domainConfig.preferredDomains;
  const followUp = secondaryDomain
    ? ` If nothing relevant returns, try the next allowlisted domain.`
    : '';

  const insightBlock = formatInsightBlock(insights);
  const conversation = historyTranscript ? `${historyTranscript}\nUser: ${message}` : message;

  const attachmentHint = buildAttachmentHint(images);
  const toolDirective = `(Use web_search with site:${stripScheme(primaryDomain)} first.${followUp})`;

  const sections = [conversation];
  if (insightBlock) {
    sections.push(insightBlock);
  }
  if (attachmentHint) {
    sections.push(attachmentHint);
  }
  sections.push(toolDirective);

  return sections.join('\n\n');
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '');
}

function hasSourcesSection(answer: string): boolean {
  return /(^|\n)\s*Sources\s*:/i.test(answer);
}

function formatHistory(history: ConversationTurn[]): string | null {
  if (history.length === 0) {
    return null;
  }

  return history
    .map((turn) => {
      const roleLabel = turn.role === 'user' ? 'User' : 'Assistant';
      const attachmentLabel = formatAttachmentLabel(turn.images);
      return attachmentLabel ? `${roleLabel}: ${turn.content} ${attachmentLabel}` : `${roleLabel}: ${turn.content}`;
    })
    .join('\n');
}

function formatAttachmentLabel(images: ConversationImage[] | undefined): string {
  if (!images || images.length === 0) {
    return '';
  }

  const names = images.map((image, index) => image.name ?? `image ${index + 1}`);
  return `(attached ${names.join(', ')})`;
}

function buildAttachmentHint(images: AskImage[] | undefined): string | null {
  if (!images || images.length === 0) {
    return null;
  }

  const labels = images.map((image, index) => image.name ?? `image ${index + 1}`);
  return (
    `Uploaded images: ${labels.join(', ')}.` +
    '\nFirst, visually analyze every attachment. Extract any readable labels, product names, numbers, or logos, and summarize the imagery before calling tools.' +
    '\nUse those findings to search melaleuca.com or the vector store so you can cite an on-domain source for every claim.' +
    '\nIf the user text is ambiguous but the image reveals the product, proceed with the best-supported answer instead of asking for another photo.'
  );
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

function ensureSourcesSection(answer: string, attachments?: AskImage[] | undefined): string {
  if (!answer.trim()) {
    return answer;
  }

  if (hasSourcesSection(answer)) {
    return answer;
  }

  const urls = extractUrls(answer);
  if (urls.length === 0 && (!attachments || attachments.length === 0)) {
    return answer;
  }

  const sourcesLines: string[] = [];
  if (urls.length > 0) {
    sourcesLines.push(...urls.map((url) => `- ${url}`));
  }

  if (attachments && attachments.length > 0) {
    attachments.forEach((attachment, index) => {
      const label = attachment.name ?? `Uploaded image ${index + 1}`;
      sourcesLines.push(`- Uploaded image: ${label}`);
    });
  }

  return `${answer.trim()}\n\nSources:\n${sourcesLines.join('\n')}`;
}

function enforceSourceAllowlist(
  answer: string,
  domainConfig: DomainConfig,
  agentProfile: AgentProfile,
  response: Response,
  attachments?: AskImage[] | undefined,
  insights?: ImageInsight[] | undefined,
): string {
  const effectiveAllowedDomains = getEffectiveAllowedDomains(domainConfig);
  const sanitizedAnswer = stripDisallowedUrlLines(answer, effectiveAllowedDomains);
  const entries = extractSourceEntries(sanitizedAnswer);
  const urls = extractUrls(sanitizedAnswer);

  const hasAllowedUrl = urls.some((url) => isAllowedSource(url, effectiveAllowedDomains));
  const hasFileCitation =
    entries.some((entry) => /file-[a-zA-Z0-9]/.test(entry)) || responseContainsFileCitation(response);
  const hasAttachmentCitation = attachments ? entries.some((entry) => matchesAttachmentEntry(entry, attachments, insights)) : false;

  if (hasAllowedUrl || hasFileCitation || hasAttachmentCitation) {
    return sanitizedAnswer;
  }

  if (agentProfile === 'csr') {
    return CSR_FALLBACK_MESSAGE;
  }

  const fallback = domainConfig.fallbackUrl;
  return `${ADMIN_FALLBACK_MESSAGE_PREFIX} Please check: ${fallback}.\n\nSources:\n- ${fallback}`;
}

function getEffectiveAllowedDomains(domainConfig: DomainConfig): string[] {
  if (settings.webSearchAllowedDomains && settings.webSearchAllowedDomains.length > 0) {
    return settings.webSearchAllowedDomains;
  }
  return toAllowedDomains(domainConfig.preferredDomains);
}

function stripDisallowedUrlLines(answer: string, allowedDomains: string[]): string {
  if (!answer.trim()) {
    return answer;
  }

  const filtered = answer
    .split('\n')
    .filter((line) => lineHasOnlyAllowedUrls(line, allowedDomains))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return filtered || answer.trim();
}

function lineHasOnlyAllowedUrls(line: string, allowedDomains: string[]): boolean {
  const urls = extractUrls(line);
  if (urls.length === 0) {
    return true;
  }
  return urls.every((url) => isAllowedSource(url, allowedDomains));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function responseContainsFileCitation(response: Response): boolean {
  for (const item of response.output ?? []) {
    if (item.type !== 'message' || item.role !== 'assistant') {
      continue;
    }

    for (const piece of item.content ?? []) {
      if (piece.type !== 'output_text') {
        continue;
      }

      if (piece.annotations?.some((annotation) => annotation.type === 'file_citation')) {
        return true;
      }
    }
  }

  return false;
}

function extractSourceEntries(answer: string): string[] {
  const match = /Sources\s*:/i.exec(answer);
  if (!match) {
    return [];
  }

  const startIndex = match.index + match[0].length;
  return answer
    .slice(startIndex)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isAllowedSource(url: string, allowedDomains: string[]): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const hostAllowed = allowedDomains.some((domain) => host === normalizeAllowedDomainHost(domain));
    if (!hostAllowed) {
      return false;
    }
    return isUsCompatibleSource(parsed);
  } catch {
    return false;
  }
}

function normalizeAllowedDomainHost(domain: string): string {
  return stripScheme(domain).split('/')[0].replace(/^www\./, '').toLowerCase().trim();
}

function isUsCompatibleSource(url: URL): boolean {
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const path = url.pathname.toLowerCase();
  const firstSegment = path.split('/').filter(Boolean)[0] ?? '';

  if (host === 'cdnsc1.melaleuca.com') {
    if (!firstSegment) {
      return true;
    }
    return firstSegment === 'na';
  }

  if (host !== 'melaleuca.com') {
    return true;
  }

  const disallowedTopLevelLocales = new Set([
    'es-us',
    'au-nz',
    'newzealand',
    'sg',
    'my',
    'kr',
    'tw',
    'fr-ca',
  ]);

  if (disallowedTopLevelLocales.has(firstSegment)) {
    return false;
  }

  const disallowedLocalePathPrefixes = ['/es-us/', '/fr-ca/', '/zh-tw/'];
  return disallowedLocalePathPrefixes.every((prefix) => !path.startsWith(prefix));
}

function matchesAttachmentEntry(entry: string, attachments: AskImage[], insights?: ImageInsight[] | undefined): boolean {
  const normalized = entry.toLowerCase();
  if (!normalized.startsWith('-')) {
    return false;
  }

  const insightLabels = insights?.map((insight) => insight.label.toLowerCase()) ?? [];

  if (insightLabels.some((label) => normalized.includes(label))) {
    return true;
  }

  return attachments.some((attachment, index) => {
    const label = (attachment.name ?? `Uploaded image ${index + 1}`).toLowerCase();
    return normalized.includes(label);
  });
}

async function extractImageInsights(images: AskImage[], topic: TopicHint): Promise<ImageInsight[]> {
  const instructions =
    'You are an assistant that extracts structured facts from product or marketing photos. ' +
    'Return concise JSON with fields: "summary" (two short sentences describing the product and notable claims), ' +
    '"visible_text" (array of distinct text snippets that appear on the packaging), and "key_terms" (array of 2-5 keywords useful for search). ' +
    'Only include text that is actually visible. Do not hallucinate brand names.';

  const insightTasks = images.map(async (image, index): Promise<ImageInsight | null> => {
    try {
      const response = await client.responses.create(
        {
          model: IMAGE_ANALYSIS_MODEL,
          max_output_tokens: 700,
          text: {
            format: {
              type: 'json_schema',
              json_schema: IMAGE_ANALYSIS_SCHEMA,
            },
          },
          input: [
            {
              role: 'system',
              content: [
                {
                  type: 'input_text',
                  text: instructions,
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: `Extract observable details from this image to help identify the product for a ${topic} catalog lookup. Respond with JSON only.`,
                },
                {
                  type: 'input_image',
                  detail: 'high',
                  image_url: `data:${image.mimeType};base64,${image.data}`,
                },
              ],
            },
          ],
        } as any,
      );

      const raw = normalizeAnswer(response);
      const parsed = parseImageInsight(raw);
      return {
        label: image.name ?? `Uploaded image ${index + 1}`,
        summary: parsed.summary,
        textSnippets: parsed.textSnippets,
        keywords: parsed.keywords,
      };
    } catch (error) {
      console.warn(`Image analysis failed for attachment ${index}:`, error);
      return null;
    }
  });

  const insightResults = await Promise.all(insightTasks);
  return insightResults.filter((insight): insight is ImageInsight => insight !== null);
}

function parseImageInsight(value: string): { summary: string; textSnippets: string[]; keywords: string[] } {
  const fallback = value.trim();
  if (!fallback) {
    return { summary: 'No image summary available.', textSnippets: [], keywords: [] };
  }

  try {
    const cleaned = stripMarkdownCodeFence(fallback);
    const data = JSON.parse(cleaned) as {
      summary?: unknown;
      visible_text?: unknown;
      key_terms?: unknown;
    };

    const summary = typeof data.summary === 'string' && data.summary.trim().length > 0 ? data.summary.trim() : fallback;
    const textSnippets =
      Array.isArray(data.visible_text) ?
        data.visible_text
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter((item) => item.length > 0)
      : [];
    const keywords =
      Array.isArray(data.key_terms) ?
        data.key_terms
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter((item) => item.length > 0)
      : [];

    return { summary, textSnippets, keywords };
  } catch {
    return { summary: fallback, textSnippets: [], keywords: [] };
  }
}

function stripMarkdownCodeFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  const fenceEnd = trimmed.lastIndexOf('```');
  if (fenceEnd <= 0) {
    return trimmed;
  }

  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline === -1) {
    return trimmed;
  }

  return trimmed.slice(firstNewline + 1, fenceEnd).trim();
}

function formatInsightBlock(insights: ImageInsight[] | undefined): string | null {
  if (!insights || insights.length === 0) {
    return null;
  }

  const blocks = insights.map((insight, index) => {
    const lines = [
      `• Summary: ${insight.summary}`,
      insight.textSnippets.length > 0 ? `• Visible text: ${insight.textSnippets.join(' | ')}` : null,
      insight.keywords.length > 0 ? `• Search cues: ${insight.keywords.join(', ')}` : null,
    ].filter((line): line is string => Boolean(line));

    return `Image ${index + 1} – ${insight.label}\n${lines.join('\n')}`;
  });

  return (
    'Vision findings derived from the uploaded image(s). Use them to ground tool calls and answer without re-requesting the label:\n' +
    `${blocks.join('\n\n')}`
  );
}
