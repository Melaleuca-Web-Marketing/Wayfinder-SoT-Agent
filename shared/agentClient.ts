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

export type ChatProgressStage = 'moderating' | 'retrieving' | 'drafting' | 'verifying' | 'finalizing';

export type ChatProgressEvent =
  | { type: 'status'; stage: ChatProgressStage; message: string; timestamp: string }
  | { type: 'result'; payload: ChatResponseBody; timestamp: string }
  | { type: 'error'; error: string; timestamp: string }
  | { type: 'done'; timestamp: string };

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

export async function sendChatRequestWithProgress(
  body: ChatRequestBody,
  onEvent: (event: ChatProgressEvent) => void,
  abortSignal?: AbortSignal,
): Promise<ChatResponseBody> {
  const response = await fetch('/api/chat/progress', {
    method: 'POST',
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
    signal: abortSignal,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const errorMessage = typeof payload.error === 'string' ? payload.error : 'Chat progress request failed';
    throw new Error(errorMessage);
  }

  if (!response.body) {
    throw new Error('Chat progress stream was empty.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let finalResult: ChatResponseBody | null = null;

  while (true) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let event: ChatProgressEvent;
      try {
        event = JSON.parse(trimmed) as ChatProgressEvent;
      } catch {
        continue;
      }

      onEvent(event);

      if (event.type === 'result') {
        finalResult = event.payload;
      }

      if (event.type === 'error') {
        throw new Error(event.error || 'Chat progress request failed');
      }
    }

    if (done) {
      break;
    }
  }

  if (!finalResult) {
    throw new Error('Chat progress stream completed without a result.');
  }

  return finalResult;
}
