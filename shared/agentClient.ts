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
  adminModelPreset?: 'gpt-4.1' | 'gpt-5.1-none' | 'gpt-5.1-low' | 'gpt-5.2-none' | 'gpt-5.2-low';
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
    stream?: {
      timeToFirstDeltaMs?: number;
      draftRevisionCount?: number;
      streamedCharsPass1?: number;
      streamedCharsPass2?: number;
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

export type ChatTokenStreamEvent =
  | ChatProgressEvent
  | { type: 'delta'; draftId: string; text: string; timestamp: string }
  | {
      type: 'revision';
      fromDraftId: string;
      toDraftId: string;
      reason: 'source_retry' | 'allowlist_replace';
      timestamp: string;
    };

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

async function buildError(response: Response, fallback: string): Promise<Error> {
  const payload = await response.json().catch(() => ({}));
  const errorMessage = typeof payload.error === 'string' ? payload.error : fallback;
  return new Error(`${errorMessage} (status ${response.status})`);
}

async function readNdjsonChatResponse<EventType extends { type: string; timestamp?: string }>(
  response: Response,
  streamName: string,
  onEvent: (event: EventType) => void,
): Promise<ChatResponseBody> {
  if (!response.body) {
    throw new Error(`${streamName} stream was empty.`);
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

      let event: EventType;
      try {
        event = JSON.parse(trimmed) as EventType;
      } catch {
        continue;
      }

      onEvent(event);

      if (event.type === 'result' && 'payload' in event) {
        finalResult = (event as EventType & { payload: ChatResponseBody }).payload;
      }

      if (event.type === 'error' && 'error' in event) {
        const eventError = (event as EventType & { error?: string }).error ?? `${streamName} request failed`;
        throw new Error(eventError);
      }
    }

    if (done) {
      break;
    }
  }

  if (!finalResult) {
    throw new Error(`${streamName} stream completed without a result.`);
  }

  return finalResult;
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
    throw await buildError(response, 'Chat progress request failed');
  }

  return readNdjsonChatResponse(response, 'Chat progress', onEvent);
}

export async function sendChatRequestWithTokenStream(
  body: ChatRequestBody,
  onEvent: (event: ChatTokenStreamEvent) => void,
  abortSignal?: AbortSignal,
): Promise<ChatResponseBody> {
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
    signal: abortSignal,
  });

  if (!response.ok) {
    throw await buildError(response, 'Chat token stream request failed');
  }

  return readNdjsonChatResponse(response, 'Chat token stream', onEvent);
}
