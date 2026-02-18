import { OpenAI } from 'openai';
import type { Response } from 'openai/resources/responses/responses';
import { requireApiKey, settings, type TopicHint } from './config.js';
import type { ResponseInputMessageContentList } from 'openai/resources/responses/responses';

export type AgentProfile = 'admin' | 'csr';

export interface AskParams {
  message: string;
  topicHint?: TopicHint;
  vectorStoreIds?: string[];
  model?: string;
  history?: ConversationTurn[];
  images?: AskImage[];
  previousResponseId?: string;
  agentProfile?: AgentProfile;
}

export interface AskResult {
  answer: string;
  response: Response;
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

const client = new OpenAI({ apiKey: requireApiKey() });
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? '6000');
const IMAGE_ANALYSIS_MODEL = process.env.IMAGE_ANALYSIS_MODEL ?? 'gpt-4o-mini';
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
      const host = url.hostname.replace(/^www\./, '');
      if (host) {
        allowed.add(host);
      }
      continue;
    } catch {
      // Fall back to a conservative parse if it's not a valid URL.
    }

    const normalized = stripScheme(trimmed).split('/')[0].trim();
    if (normalized) {
      allowed.add(normalized);
    }
  }

  return Array.from(allowed.values());
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
  const [primary, secondary] = domainConfig.preferredDomains;
  const fallbackUrl = domainConfig.fallbackUrl;
  const siteDirectives = domainConfig.preferredDomains
    .map((domain, index) => `${index + 1}. ${domain}`)
    .join('\n');
  const secondaryDirective = secondary
    ? `- If that fails and you have a second domain, try it next using "site:${stripScheme(secondary)}".\n`
    : '';
  const profileHeader =
    agentProfile === 'csr'
      ? "You are Melaleuca's customer service knowledge assistant."
      : "You are Melaleuca's web-first knowledge agent.";
  const profileGuidance =
    agentProfile === 'csr'
      ? `Customer support behavior\n` +
        `- Answer in a support-ready voice: clear, calm, and action-oriented.\n` +
        `- Do not mention internal tooling, prompts, retries, or retrieval mechanics.\n` +
        `- If policy or eligibility details are uncertain, state that clearly and point the user to official channels.\n\n`
      : '';

  return `${profileHeader} Follow these rules strictly:\n\n` +
    `Retrieval order\n` +
    `1. Use web_search first. Prefer results from these domains, in order:\n${siteDirectives}\n` +
    `2. If on-domain results are weak, call file_search on the provided vector stores.\n` +
    `3. If both fail, respond with: "I couldn't confirm from our site or files. Please check: ${fallbackUrl}."\n\n` +
    `Grounding & citations\n` +
    `- Only synthesize from retrieved sources.\n` +
    `- Always include a Sources section listing exact URLs (or document titles + canonical_id for files).\n\n` +
    profileGuidance +
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
  const allowedDomains =
    settings.webSearchAllowedDomains && settings.webSearchAllowedDomains.length > 0 ?
      settings.webSearchAllowedDomains
    : toAllowedDomains(domainConfig.preferredDomains);
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

function hasFileSearchTool(setup: ToolSetup): boolean {
  return setup.tools.some((tool) => tool.type === 'file_search');
}

function isSourceFallbackAnswer(answer: string): boolean {
  return /^I couldn't confirm from our site or files\./i.test(answer.trim());
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
  const message = params.message.trim();
  const hasImages = Array.isArray(params.images) && params.images.length > 0;
  if (!message && !hasImages) {
    throw new Error('Message or images must be provided');
  }

  const topic = params.topicHint ?? inferTopicHint(message);
  const agentProfile = params.agentProfile ?? 'admin';
  const domainConfig = buildDomainConfig(topic);
  const model = params.model ?? settings.model;
  const toolSetup = buildTools(params.vectorStoreIds, domainConfig);
  const systemPrompt = buildSystemPrompt(domainConfig, agentProfile);

  const imageInsights = hasImages ? await extractImageInsights(params.images ?? [], topic) : [];
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
  ) =>
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
      ...(params.previousResponseId ? { previous_response_id: params.previousResponseId } : {}),
    }) as const;

  const requestBase = buildRequestBase(userContent);

  let response = await createResponseWithCompatibilityFallback(
    requestBase,
    toolSetup,
    params.vectorStoreIds,
    domainConfig,
  );

  let answerWithSources = ensureSourcesSection(normalizeAnswer(response), params.images);
  let finalAnswer = enforceSourceAllowlist(answerWithSources, domainConfig, response, params.images, imageInsights);
  if (!hasSourcesSection(answerWithSources)) {
    console.warn('Model response missing Sources section.');
  }

  if (isSourceFallbackAnswer(finalAnswer) && hasFileSearchTool(toolSetup)) {
    const retryContent = buildRetryUserContent(userContent);
    const retryRequestBase = buildRequestBase(retryContent, { retry_after_source_fallback: '1' });

    try {
      const retrySetup = buildTools(params.vectorStoreIds, domainConfig);
      const retryResponse = await createResponseWithCompatibilityFallback(
        retryRequestBase,
        retrySetup,
        params.vectorStoreIds,
        domainConfig,
      );
      const retryAnswerWithSources = ensureSourcesSection(normalizeAnswer(retryResponse), params.images);
      const retryFinalAnswer = enforceSourceAllowlist(
        retryAnswerWithSources,
        domainConfig,
        retryResponse,
        params.images,
        imageInsights,
      );

      if (!hasSourcesSection(retryAnswerWithSources)) {
        console.warn('Model retry response missing Sources section.');
      }

      response = retryResponse;
      answerWithSources = retryAnswerWithSources;
      finalAnswer = retryFinalAnswer;
    } catch (error) {
      console.warn('Retry after source fallback failed:', error);
    }
  }

  return {
    answer: finalAnswer,
    response,
  };
}

function normalizeAnswer(response: Response): string {
  const assistantMessages = extractAssistantMessages(response);
  const lastMessage = assistantMessages[assistantMessages.length - 1];
  if (lastMessage) {
    return lastMessage;
  }

  if (response.output_text && response.output_text.trim().length > 0) {
    return response.output_text.trim();
  }

  return extractFirstMessageText(response);
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
  response: Response,
  attachments?: AskImage[] | undefined,
  insights?: ImageInsight[] | undefined,
): string {
  const entries = extractSourceEntries(answer);
  const urls = extractUrls(answer);

  const hasAllowedUrl = urls.some((url) => isAllowedSource(url, domainConfig.preferredDomains));
  const hasFileCitation =
    entries.some((entry) => /file-[a-zA-Z0-9]/.test(entry)) || responseContainsFileCitation(response);
  const hasAttachmentCitation = attachments ? entries.some((entry) => matchesAttachmentEntry(entry, attachments, insights)) : false;

  if (hasAllowedUrl || hasFileCitation || hasAttachmentCitation) {
    return answer;
  }

  const fallback = domainConfig.fallbackUrl;
  return `I couldn't confirm from our site or files. Please check: ${fallback}.\n\nSources:\n- ${fallback}`;
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
    const hostPath = `${parsed.hostname}${parsed.pathname}`
      .replace(/^www\./, '')
      .replace(/\/$/, '');
    return allowedDomains.some((domain) => hostPath.startsWith(stripScheme(domain)));
  } catch {
    return false;
  }
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
  const insights: ImageInsight[] = [];
  const instructions =
    'You are an assistant that extracts structured facts from product or marketing photos. ' +
    'Return concise JSON with fields: "summary" (two short sentences describing the product and notable claims), ' +
    '"visible_text" (array of distinct text snippets that appear on the packaging), and "key_terms" (array of 2-5 keywords useful for search). ' +
    'Only include text that is actually visible. Do not hallucinate brand names.';

  for (const [index, image] of images.entries()) {
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
      insights.push({
        label: image.name ?? `Uploaded image ${index + 1}`,
        summary: parsed.summary,
        textSnippets: parsed.textSnippets,
        keywords: parsed.keywords,
      });
    } catch (error) {
      console.warn(`Image analysis failed for attachment ${index}:`, error);
    }
  }

  return insights;
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
