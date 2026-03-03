import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, FormEvent } from 'react';
import {
  sendChatRequestWithTokenStream,
  sendChatRequestWithProgress,
  fetchRealtimeToken,
  type ChatRequestBody,
  type ChatProgressEvent,
  type ChatResponseBody,
  type ChatTokenStreamEvent,
} from '../../../shared/agentClient';

type Role = 'user' | 'assistant';

interface ChatImage {
  id: string;
  url: string;
  name: string;
  mimeType: string;
}

interface ChatTurn {
  id: string;
  role: Role;
  content: string;
  streaming?: boolean;
  images?: ChatImage[];
  trace?: TurnTrace;
}

interface AttachmentDraft {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  base64: string;
}

type VoiceStatus = 'idle' | 'connecting' | 'active';
type AdminModelPreset = 'gpt-4.1' | 'gpt-5.1-none' | 'gpt-5.1-low' | 'gpt-5.2-none' | 'gpt-5.2-low';
type ResponseMode = 'not-tested' | 'token-stream' | 'progress-fallback';

interface TurnTrace {
  mode: Exclude<ResponseMode, 'not-tested'>;
  traceId?: string;
  responseId?: string;
  client: {
    sentAt: string;
    firstTokenAt?: string;
    doneAt: string;
    timeToFirstTokenMs?: number;
    totalMs: number;
  };
  backend?: ChatResponseBody['metrics'];
}

const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024; // 4MB

const makeId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));

const formatMessage = (content: string) => {
  if (!content) {
    return null;
  }
  return content.split('\n').map((line, index) => (
    <p key={index}>{line || '\u00a0'}</p>
  ));
};

type ParsedSources = {
  body: string;
  sources: string[];
};

const splitSources = (content: string): ParsedSources => {
  const lines = content.split('\n');
  const markerIndex = lines.findIndex((line) => /^\s*Sources\s*:/i.test(line));
  if (markerIndex === -1) {
    return { body: content, sources: [] };
  }

  const body = lines.slice(0, markerIndex).join('\n').trim();
  const sources = lines
    .slice(markerIndex + 1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^[-*]\s*/, ''));

  return { body, sources };
};

type SourceChip = {
  label: string;
  url?: string;
};

const buildSourceChip = (source: string): SourceChip => {
  const match = source.match(/https?:\/\/[^\s)]+/i);
  if (!match) {
    return { label: source };
  }

  const url = match[0].replace(/[),.;]+$/, '');
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    return { label: host || url, url };
  } catch {
    return { label: url, url };
  }
};

const readFileAsDataURL = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to read image.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read image.'));
    reader.readAsDataURL(file);
  });
};

const mapBackendModelToAdminPreset = (model: string | undefined): AdminModelPreset | null => {
  const normalized = (model ?? '').trim().toLowerCase();
  if (normalized === 'gpt-4.1') {
    return 'gpt-4.1';
  }
  if (normalized === 'gpt-5.1') {
    return 'gpt-5.1-none';
  }
  if (normalized === 'gpt-5.2') {
    return 'gpt-5.2-none';
  }
  return null;
};

const shouldFallbackToProgress = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const normalized = error.message.toLowerCase();
  return normalized.includes('token streaming endpoint is disabled') || normalized.includes('status 404');
};

const formatMs = (value: number | undefined): string => {
  if (value == null || Number.isNaN(value)) {
    return 'n/a';
  }
  return `${Math.max(0, Math.round(value))} ms`;
};

const formatTimestamp = (iso: string | undefined): string => {
  if (!iso) {
    return 'n/a';
  }

  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return 'n/a';
  }

  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

export function ChatPanel() {
  const [topicHint, setTopicHint] = useState<'melaleuca' | 'riverbend'>('melaleuca');
  const [adminModelPreset, setAdminModelPreset] = useState<AdminModelPreset>('gpt-5.2-none');
  const [responseMode, setResponseMode] = useState<ResponseMode>('not-tested');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [chatProgressMessage, setChatProgressMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previousResponseId, setPreviousResponseId] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const endRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingIdsRef = useRef<{ user?: string; assistant?: string }>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hasManualModelSelectionRef = useRef(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, voiceStatus]);

  useEffect(() => {
    return () => {
      stopVoiceSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    const syncPresetFromBackend = async () => {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as { ok?: boolean; model?: string };
        if (!data.ok || hasManualModelSelectionRef.current || cancelled) {
          return;
        }
        const mappedPreset = mapBackendModelToAdminPreset(data.model);
        if (mappedPreset) {
          setAdminModelPreset(mappedPreset);
        }
      } catch {
        // If status probing fails, keep the local default preset.
      }
    };

    void syncPresetFromBackend();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAttachmentButton = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const processFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList ?? []);
      if (files.length === 0) {
        return;
      }

      const availableSlots = MAX_ATTACHMENTS - attachments.length;
      if (availableSlots <= 0) {
        setError(`You can attach up to ${MAX_ATTACHMENTS} images.`);
        return;
      }

      const selected = files.slice(0, availableSlots);
      const additions: AttachmentDraft[] = [];

      for (const file of selected) {
        if (!file.type.startsWith('image/')) {
          setError('Only image files are supported (PNG, JPEG, WEBP).');
          continue;
        }

        if (file.size > MAX_ATTACHMENT_BYTES) {
          const mb = Math.round((MAX_ATTACHMENT_BYTES / (1024 * 1024)) * 10) / 10;
          setError(`Images must be ${mb}MB or smaller.`);
          continue;
        }

        try {
          const dataUrl = await readFileAsDataURL(file);
          const base64 = dataUrl.split(',')[1];
          if (!base64) {
            setError('Unable to read one of the selected images.');
            continue;
          }
          additions.push({
            id: makeId(),
            name: file.name || 'image',
            mimeType: file.type,
            size: file.size,
            dataUrl,
            base64,
          });
        } catch (readError) {
          setError(readError instanceof Error ? readError.message : 'Unable to read image.');
        }
      }

      if (additions.length > 0) {
        setAttachments((prev) => [...prev, ...additions].slice(0, MAX_ATTACHMENTS));
      }
    },
    [attachments.length],
  );

  const handleFileInputChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      if (event.target.files && event.target.files.length > 0) {
        await processFiles(event.target.files);
        event.target.value = '';
      }
    },
    [processFiles],
  );

  const handlePaste = useCallback(
    async (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = event.clipboardData?.files;
      if (!items || items.length === 0) {
        return;
      }

      const images = Array.from(items).filter((file) => file.type.startsWith('image/'));
      if (images.length === 0) {
        return;
      }

      event.preventDefault();
      await processFiles(images);
    },
    [processFiles],
  );

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  }, []);

  const finalizeMessage = useCallback((id?: string) => {
    if (!id) {
      return;
    }
    setMessages((prev) =>
      prev.map((message) =>
        message.id === id
          ? {
              ...message,
              streaming: false,
            }
          : message,
      ),
    );
  }, []);

  const appendDelta = useCallback(
    (role: Role, delta: string) => {
      if (!delta) {
        return;
      }

      const pendingId = pendingIdsRef.current[role];
      if (!pendingId) {
        const id = makeId();
        pendingIdsRef.current[role] = id;
        setMessages((prev) => [...prev, { id, role, content: delta, streaming: true }]);
        return;
      }

      setMessages((prev) =>
        prev.map((message) =>
          message.id === pendingId
            ? {
                ...message,
                content: message.content + delta,
                streaming: true,
              }
            : message,
        ),
      );
    },
    [],
  );

  const finalizeRole = useCallback(
    (role: Role) => {
      const id = pendingIdsRef.current[role];
      if (!id) {
        return;
      }
      finalizeMessage(id);
      delete pendingIdsRef.current[role];
    },
    [finalizeMessage],
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = input.trim();
      if ((trimmed.length === 0 && attachments.length === 0) || loading) {
        return;
      }

      setInput('');
      setError(null);

      const historyPayload =
        previousResponseId ?
          []
        : messages.map((turn) => ({
            role: turn.role,
            content: turn.content,
            images: turn.images?.map(({ name, mimeType }) => ({ name, mimeType })),
          }));

      const imagePayload = attachments.map((attachment) => ({
        data: attachment.base64,
        mimeType: attachment.mimeType,
        name: attachment.name,
      }));

      const userImages: ChatImage[] = attachments.map((attachment) => ({
        id: attachment.id,
        url: attachment.dataUrl,
        name: attachment.name,
        mimeType: attachment.mimeType,
      }));

      const displayContent = trimmed.length > 0 ? trimmed : userImages.length > 0 ? '(Image attachment)' : '';

      const userMessage: ChatTurn = {
        id: makeId(),
        role: 'user',
        content: displayContent,
        images: userImages.length > 0 ? userImages : undefined,
      };

      setMessages((prev) => [...prev, userMessage]);
      setAttachments([]);
      setLoading(true);
      setChatProgressMessage('Running safety checks...');

      try {
        const requestSentAtMs = Date.now();
        const requestSentPerfMs = performance.now();
        let firstTokenAtMs: number | undefined;
        let firstTokenPerfMs: number | undefined;
        const markFirstToken = () => {
          if (firstTokenAtMs != null) {
            return;
          }
          firstTokenAtMs = Date.now();
          firstTokenPerfMs = performance.now();
        };

        const draftMessageId = makeId();
        let activeDraftId: string | null = null;

        const replaceDraft = (content: string, streaming: boolean) => {
          setMessages((prev) => {
            let found = false;
            const next = prev.map((turn) => {
              if (turn.id !== draftMessageId) {
                return turn;
              }
              found = true;
              return { ...turn, content, streaming };
            });

            if (!found) {
              next.push({ id: draftMessageId, role: 'assistant', content, streaming });
            }
            return next;
          });
        };

        const appendDraft = (delta: string) => {
          if (!delta) {
            return;
          }

          setMessages((prev) => {
            let found = false;
            const next = prev.map((turn) => {
              if (turn.id !== draftMessageId) {
                return turn;
              }
              found = true;
              return {
                ...turn,
                content: turn.content + delta,
                streaming: true,
              };
            });

            if (!found) {
              next.push({ id: draftMessageId, role: 'assistant', content: delta, streaming: true });
            }
            return next;
          });
        };

        const finalizeDraft = (content: string, trace: TurnTrace) => {
          setMessages((prev) => {
            let found = false;
            const next = prev.map((turn) => {
              if (turn.id !== draftMessageId) {
                return turn;
              }
              found = true;
              return {
                ...turn,
                content,
                streaming: false,
                trace,
              };
            });

            if (!found) {
              next.push({ id: draftMessageId, role: 'assistant', content, streaming: false, trace });
            }
            return next;
          });
        };

        const requestBody: ChatRequestBody = {
          message: trimmed,
          topicHint,
          history: historyPayload,
          images: imagePayload,
          agentProfile: 'admin',
          adminModelPreset,
          ...(previousResponseId ? { previousResponseId } : {}),
        };
        let usedTokenStream = true;
        let data: ChatResponseBody;

        try {
          data = await sendChatRequestWithTokenStream(requestBody, (event: ChatTokenStreamEvent) => {
            switch (event.type) {
              case 'status':
                setChatProgressMessage(event.message);
                break;
              case 'delta':
                markFirstToken();
                if (activeDraftId && event.draftId !== activeDraftId) {
                  activeDraftId = event.draftId;
                  replaceDraft(event.text, true);
                  break;
                }
                activeDraftId = event.draftId;
                appendDraft(event.text);
                setChatProgressMessage('Drafting response...');
                break;
              case 'revision':
                activeDraftId = event.toDraftId;
                replaceDraft('', true);
                setChatProgressMessage(
                  event.reason === 'source_retry' ?
                    'Re-checking sources and revising answer...'
                  : 'Applying source-safe fallback...',
                );
                break;
              case 'result':
                markFirstToken();
                replaceDraft(event.payload.answer, false);
                setChatProgressMessage('Finalizing response...');
                break;
              case 'error':
                setChatProgressMessage('Streaming failed. Retrying…');
                break;
              case 'done':
                break;
            }
          });
          setResponseMode('token-stream');
        } catch (streamError) {
          if (!shouldFallbackToProgress(streamError)) {
            throw streamError;
          }

          usedTokenStream = false;
          setResponseMode('progress-fallback');
          replaceDraft('', true);
          data = await sendChatRequestWithProgress(requestBody, (event: ChatProgressEvent) => {
            if (event.type === 'status') {
              setChatProgressMessage(event.message);
            } else if (event.type === 'result') {
              markFirstToken();
              setChatProgressMessage('Finalizing response...');
            }
          });
        }

        const responseId =
          data.responseId ??
          (data.response && typeof data.response === 'object' && 'id' in data.response ?
            (data.response as { id?: string }).id
          : undefined);

        const doneAtMs = Date.now();
        const donePerfMs = performance.now();
        const totalClientMs = Math.max(0, Math.round(donePerfMs - requestSentPerfMs));
        const timeToFirstTokenMs =
          firstTokenPerfMs != null ? Math.max(0, Math.round(firstTokenPerfMs - requestSentPerfMs)) : undefined;
        const trace: TurnTrace = {
          mode: usedTokenStream ? 'token-stream' : 'progress-fallback',
          traceId: data.traceId,
          responseId,
          client: {
            sentAt: new Date(requestSentAtMs).toISOString(),
            ...(firstTokenAtMs != null ? { firstTokenAt: new Date(firstTokenAtMs).toISOString() } : {}),
            doneAt: new Date(doneAtMs).toISOString(),
            ...(timeToFirstTokenMs != null ? { timeToFirstTokenMs } : {}),
            totalMs: totalClientMs,
          },
          backend: data.metrics,
        };

        finalizeDraft(data.answer, trace);
        setPreviousResponseId(responseId ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Chat request failed');
      } finally {
        setLoading(false);
        setChatProgressMessage(null);
      }
    },
    [adminModelPreset, attachments, input, loading, messages, previousResponseId, topicHint],
  );

  const stopVoiceSession = useCallback(() => {
    dataChannelRef.current?.close();
    dataChannelRef.current = null;

    peerRef.current?.close();
    peerRef.current = null;

    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }

    finalizeRole('assistant');
    finalizeRole('user');
    pendingIdsRef.current = {};
    setVoiceStatus('idle');
  }, [finalizeRole]);

  const handleRealtimeEvent = useCallback(
    (raw: string) => {
      try {
        const data = JSON.parse(raw);
        switch (data.type) {
          case 'response.output_text.delta':
            appendDelta('assistant', data.delta ?? '');
            break;
          case 'response.output_text.done':
          case 'response.completed':
            finalizeRole('assistant');
            break;
          case 'response.input_text.delta':
          case 'conversation.item.input_audio_transcription.delta':
            appendDelta('user', data.delta ?? data.text ?? '');
            break;
          case 'response.input_text.done':
          case 'conversation.item.input_audio_transcription.completed':
            finalizeRole('user');
            break;
          case 'error':
            setVoiceError(data.error?.message ?? 'Realtime error');
            break;
          default:
            // console.debug('Realtime event', data);
            break;
        }
      } catch (err) {
        console.error('Failed to parse realtime event', err, raw);
      }
    },
    [appendDelta, finalizeRole],
  );

  const startVoiceSession = useCallback(async () => {
    try {
      setVoiceError(null);
      setVoiceStatus('connecting');

      const tokenResponse = await fetchRealtimeToken();
      if (!tokenResponse.ok) {
        const payload = await tokenResponse.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Unable to create realtime session');
      }

      const session = await tokenResponse.json();

      const pc = new RTCPeerConnection();
      peerRef.current = pc;

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
          stopVoiceSession();
        }
      };

      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

      pc.ontrack = (event) => {
        if (audioRef.current) {
          // eslint-disable-next-line no-param-reassign
          audioRef.current.srcObject = event.streams[0];
        }
      };

      const dataChannel = pc.createDataChannel('oai-events');
      dataChannelRef.current = dataChannel;
      dataChannel.onmessage = (event) => handleRealtimeEvent(event.data);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
        } else {
          const checkState = () => {
            if (pc.iceGatheringState === 'complete') {
              pc.removeEventListener('icegatheringstatechange', checkState);
              resolve();
            }
          };
          pc.addEventListener('icegatheringstatechange', checkState);
        }
      });

      const localDescription = pc.localDescription;
      if (!localDescription?.sdp) {
        throw new Error('Missing local description');
      }

      const sdpResponse = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(session.model)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.client_secret.value}`,
          'Content-Type': 'application/sdp',
        },
        body: localDescription.sdp,
      });

      if (!sdpResponse.ok) {
        const text = await sdpResponse.text();
        throw new Error(text || 'Realtime handshake failed');
      }

      const answer = await sdpResponse.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });

      setVoiceStatus('active');
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : 'Voice session failed');
      stopVoiceSession();
    }
  }, [handleRealtimeEvent, stopVoiceSession]);

  const isVoiceConnecting = voiceStatus === 'connecting';
  const isVoiceActive = voiceStatus === 'active';

  const remainingAttachmentSlots = Math.max(0, MAX_ATTACHMENTS - attachments.length);
  const canSubmit = input.trim().length > 0 || attachments.length > 0;
  const hasStreamingAssistantDraft = useMemo(
    () => messages.some((turn) => turn.role === 'assistant' && turn.streaming),
    [messages],
  );
  const responseModeMeta = useMemo(() => {
    switch (responseMode) {
      case 'token-stream':
        return { label: 'Token stream', className: 'token' };
      case 'progress-fallback':
        return { label: 'Progress fallback', className: 'fallback' };
      default:
        return { label: 'Not tested', className: 'neutral' };
    }
  }, [responseMode]);

  const handleVoiceToggle = useCallback(() => {
    if (isVoiceActive || isVoiceConnecting) {
      stopVoiceSession();
    } else {
      void startVoiceSession();
    }
  }, [isVoiceActive, isVoiceConnecting, startVoiceSession, stopVoiceSession]);

  const voiceStatusLabel = useMemo(() => {
    switch (voiceStatus) {
      case 'connecting':
        return 'Voice session connecting…';
      case 'active':
        return 'Voice session active';
      default:
        return null;
    }
  }, [voiceStatus]);

  const handleTopicChange = useCallback((value: 'melaleuca' | 'riverbend') => {
    setTopicHint(value);
    // Switching domain focus should start a fresh thread to avoid cross-topic carryover.
    setPreviousResponseId(null);
    setMessages([]);
    setAttachments([]);
    setResponseMode('not-tested');
    setError(null);
  }, []);

  const handleModelPresetChange = useCallback((value: AdminModelPreset) => {
    hasManualModelSelectionRef.current = true;
    setAdminModelPreset(value);
    // Model changes should start a fresh thread for clean A/B comparisons.
    setPreviousResponseId(null);
    setMessages([]);
    setAttachments([]);
    setResponseMode('not-tested');
    setError(null);
  }, []);

  return (
    <section className="chat-panel">
      <header>
        <h2>Knowledge Chat</h2>
        <div className="chat-controls">
          <label>
            Domain focus
            <select
              value={topicHint}
              onChange={(event) => handleTopicChange(event.target.value as 'melaleuca' | 'riverbend')}
            >
              <option value="melaleuca">Melaleuca</option>
              <option value="riverbend">Riverbend Ranch</option>
            </select>
          </label>
          <label>
            Model
            <select
              value={adminModelPreset}
              onChange={(event) => handleModelPresetChange(event.target.value as AdminModelPreset)}
            >
              <option value="gpt-4.1">gpt-4.1</option>
              <option value="gpt-5.1-none">gpt-5.1-none</option>
              <option value="gpt-5.1-low">gpt-5.1-low</option>
              <option value="gpt-5.2-none">gpt-5.2-none</option>
              <option value="gpt-5.2-low">gpt-5.2-low</option>
            </select>
          </label>
          <div className={`chat-mode-badge ${responseModeMeta.className}`} title="Runtime response delivery mode for the latest request.">
            <span className="label">Response mode</span>
            <span className="value">{responseModeMeta.label}</span>
          </div>
          <button
            type="button"
            className={isVoiceActive || isVoiceConnecting ? 'danger' : 'secondary'}
            onClick={handleVoiceToggle}
            disabled={isVoiceConnecting}
          >
            {isVoiceActive || isVoiceConnecting ? 'Stop voice' : 'Start voice'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setMessages([]);
              setAttachments([]);
              setPreviousResponseId(null);
              setResponseMode('not-tested');
            }}
            disabled={loading}
          >
            Clear history
          </button>
        </div>
      </header>

      {voiceStatusLabel && <div className={`chat-voice-status status-${voiceStatus}`}>{voiceStatusLabel}</div>}

      <div className="chat-transcript">
        {messages.length === 0 && !loading && <p className="empty">Ask something to get started.</p>}
        {messages.map((turn, index) => {
          const parsed = turn.role === 'assistant' ? splitSources(turn.content) : { body: turn.content, sources: [] };
          const content = formatMessage(parsed.body);
          const sourceChips = parsed.sources.map(buildSourceChip);
          return (
            <div key={turn.id ?? index} className={`chat-turn ${turn.role} ${turn.streaming ? 'streaming' : ''}`}>
              <div className="chat-role">{turn.role === 'user' ? 'You' : 'Assistant'}</div>
              <div className="chat-content">
                {content}
                {turn.images && turn.images.length > 0 && (
                  <div className="chat-content-images">
                    {turn.images.map((image) => (
                      <figure key={image.id} className="chat-image">
                        <img src={image.url} alt={image.name} />
                        <figcaption>{image.name}</figcaption>
                      </figure>
                    ))}
                  </div>
                )}
                {sourceChips.length > 0 && (
                  <div className="chat-sources">
                    <span className="chat-sources-label">Sources</span>
                    <div className="chat-source-chips">
                      {sourceChips.map((chip, chipIndex) =>
                        chip.url ? (
                          <a key={`${chip.url}-${chipIndex}`} href={chip.url} target="_blank" rel="noreferrer" className="chat-source-chip">
                            {chip.label}
                          </a>
                        ) : (
                          <span key={`${chip.label}-${chipIndex}`} className="chat-source-chip">
                            {chip.label}
                          </span>
                        ),
                      )}
                    </div>
                  </div>
                )}
                {turn.role === 'assistant' && turn.trace && (
                  <details className="chat-trace">
                    <summary>Latency trace</summary>
                    <div className="chat-trace-grid">
                      <div className="chat-trace-item">
                        <span>Mode</span>
                        <strong>{turn.trace.mode === 'token-stream' ? 'Token stream' : 'Progress fallback'}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Client total</span>
                        <strong>{formatMs(turn.trace.client.totalMs)}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Client first token</span>
                        <strong>{formatMs(turn.trace.client.timeToFirstTokenMs)}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Sent at</span>
                        <strong>{formatTimestamp(turn.trace.client.sentAt)}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Done at</span>
                        <strong>{formatTimestamp(turn.trace.client.doneAt)}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Backend total</span>
                        <strong>{formatMs(turn.trace.backend?.totalMs)}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Moderation</span>
                        <strong>{formatMs(turn.trace.backend?.moderationMs)}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Vector store</span>
                        <strong>{formatMs(turn.trace.backend?.vectorStoreMs)}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Ask total</span>
                        <strong>{formatMs(turn.trace.backend?.askMs)}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Image analysis</span>
                        <strong>{formatMs(turn.trace.backend?.ask?.imageAnalysisMs)}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Initial response</span>
                        <strong>{formatMs(turn.trace.backend?.ask?.initialResponseMs)}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Stream first delta</span>
                        <strong>{formatMs(turn.trace.backend?.stream?.timeToFirstDeltaMs)}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Draft revisions</span>
                        <strong>{turn.trace.backend?.stream?.draftRevisionCount ?? 'n/a'}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Web searches</span>
                        <strong>{turn.trace.backend?.retrieval?.webSearchCallCount ?? 'n/a'}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>File searches</span>
                        <strong>{turn.trace.backend?.retrieval?.fileSearchCallCount ?? 'n/a'}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Retries (attempt/success)</span>
                        <strong>
                          {(turn.trace.backend?.retries?.attemptedCount ?? 0).toString()}/
                          {(turn.trace.backend?.retries?.successCount ?? 0).toString()}
                        </strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Answer chars</span>
                        <strong>{turn.trace.backend?.output?.answerChars ?? 'n/a'}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Source count</span>
                        <strong>{turn.trace.backend?.output?.sourceCount ?? 'n/a'}</strong>
                      </div>
                      <div className="chat-trace-item">
                        <span>Trace ID</span>
                        <code>{turn.trace.traceId ?? 'n/a'}</code>
                      </div>
                      <div className="chat-trace-item">
                        <span>Response ID</span>
                        <code>{turn.trace.responseId ?? 'n/a'}</code>
                      </div>
                    </div>
                  </details>
                )}
              </div>
            </div>
          );
        })}
        {loading && !hasStreamingAssistantDraft && (
          <div className="chat-turn assistant">
            <div className="chat-role">Assistant</div>
            <div className="chat-content">{chatProgressMessage ?? 'Thinking…'}</div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && <div className="chat-error">{error}</div>}
      {voiceError && <div className="chat-error">{voiceError}</div>}

      <form className="chat-form" onSubmit={handleSubmit}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onPaste={handlePaste}
          placeholder="Ask a question about Melaleuca or Riverbend Ranch…"
          rows={3}
          disabled={loading}
        />
        {attachments.length > 0 && (
          <div className="chat-form-attachments">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="chat-form-attachment">
                <img src={attachment.dataUrl} alt={attachment.name} />
                <button type="button" onClick={() => handleRemoveAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="chat-form-actions">
          <div className="chat-form-action-group">
            <button
              type="button"
              className="secondary"
              onClick={handleAttachmentButton}
              disabled={loading || remainingAttachmentSlots === 0}
            >
              Attach image
            </button>
            <span className="chat-form-hint">{remainingAttachmentSlots} slot{remainingAttachmentSlots === 1 ? '' : 's'} left</span>
          </div>
          <button type="submit" disabled={loading || !canSubmit}>
            Send
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="chat-file-input"
          onChange={handleFileInputChange}
          hidden
        />
      </form>

      <audio ref={audioRef} autoPlay className="voice-audio" />
    </section>
  );
}
