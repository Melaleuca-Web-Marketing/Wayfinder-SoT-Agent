export interface ChatAttachmentInput {
  data: string;
  mimeType: string;
  name?: string;
}

export interface ChatHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  images?: Array<{
    name?: string;
    mimeType?: string;
  }>;
}

export interface ChatRequestBody {
  message: string;
  topicHint?: 'melaleuca' | 'riverbend';
  history?: ChatHistoryTurn[];
  images?: ChatAttachmentInput[];
  previousResponseId?: string;
  agentProfile?: 'admin' | 'csr';
  adminModelPreset?: 'gpt-4.1' | 'gpt-5.1-none' | 'gpt-5.1-low';
}

export interface ChatResponseBody {
  answer: string;
  response?: unknown;
  responseId?: string;
  metrics?: {
    totalMs?: number;
    moderationMs?: number;
    vectorStoreMs?: number;
    askMs?: number;
    ask?: {
      imageAnalysisMs?: number;
      initialResponseMs?: number;
      retries?: Array<{
        reason?: 'admin_source_fallback' | 'csr_source_fallback';
        attempted?: boolean;
        succeeded?: boolean;
        durationMs?: number;
      }>;
      totalMs?: number;
    };
    retries?: {
      triggered?: boolean;
      attemptedCount?: number;
      successCount?: number;
    };
    aggregate?: {
      totalRequests?: number;
      retryTriggeredRequests?: number;
      retryAttemptCount?: number;
      retrySuccessCount?: number;
      retryTriggeredRate?: number;
      retrySuccessRate?: number;
    };
  };
}

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
};

export async function sendChatRequest(body: ChatRequestBody, abortSignal?: AbortSignal): Promise<ChatResponseBody> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
    signal: abortSignal,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const errorMessage = typeof payload.error === 'string' ? payload.error : 'Chat request failed';
    throw new Error(errorMessage);
  }

  return response.json() as Promise<ChatResponseBody>;
}

export async function fetchRealtimeToken(): Promise<Response> {
  return fetch('/api/realtime/token', { method: 'POST' });
}
