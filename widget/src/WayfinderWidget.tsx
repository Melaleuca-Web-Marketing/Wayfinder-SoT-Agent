import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  sendChatRequest,
  fetchRealtimeToken,
  type ChatRequestBody,
  type ChatResponseBody,
  type ChatHistoryTurn,
} from '../../shared/agentClient';
import './widget.css';

type ChatRole = 'user' | 'assistant';

interface WidgetMessage {
  id: string;
  role: ChatRole;
  content: string;
  images?: WidgetImage[];
  synthetic?: boolean;
  streaming?: boolean;
}

interface WidgetImage {
  id: string;
  url: string;
  name: string;
  mimeType: string;
}

export interface WayfinderWidgetProps {
  topicHint?: 'melaleuca' | 'riverbend';
  welcomeMessage?: string;
  label?: string;
}

const DEFAULT_WELCOME =
  'Hi there! I’m your Wayfinder assistant. Ask about Melaleuca products, policies, or Riverbend Ranch and I’ll cite our official sources.';

const makeId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

const readFileAsDataURL = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Unable to read image.'));
      }
    };
    reader.onerror = () => reject(new Error('Unable to read image.'));
    reader.readAsDataURL(file);
  });
};

export function WayfinderWidget(props: WayfinderWidgetProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<WidgetMessage[]>(() => [
    {
      id: makeId(),
      role: 'assistant',
      content: props.welcomeMessage ?? DEFAULT_WELCOME,
      synthetic: true,
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<WidgetImage[]>([]);
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'connecting' | 'active'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingIdsRef = useRef<{ user?: string; assistant?: string }>({});

  const toggleOpen = useCallback(() => {
    setOpen((prev) => !prev);
    setError(null);
    setVoiceError(null);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    bodyRef.current?.scrollTo({
      top: bodyRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, open]);

  const historyPayload = useMemo<ChatHistoryTurn[]>(() => {
    return messages
      .filter((message) => !message.synthetic)
      .map((message) => ({
        role: message.role,
        content: message.content,
        images: message.images?.map((image) => ({
          name: image.name,
          mimeType: image.mimeType,
        })),
      }));
  }, [messages]);

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
      const additions: WidgetImage[] = [];

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
            url: dataUrl,
          });
        } catch (processError) {
          setError(processError instanceof Error ? processError.message : 'Unable to read image.');
        }
      }

      if (additions.length > 0) {
        setAttachments((prev) => [...prev, ...additions].slice(0, MAX_ATTACHMENTS));
      }
    },
    [attachments.length],
  );

  const handleAttachmentButton = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
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

  const appendDelta = useCallback((role: ChatRole, delta: string) => {
    if (!delta) {
      return;
    }

    const pendingId = pendingIdsRef.current[role];
    if (!pendingId) {
      const id = makeId();
      pendingIdsRef.current[role] = id;
      setMessages((prev) => [
        ...prev,
        {
          id,
          role,
          content: delta,
          streaming: true,
        },
      ]);
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
  }, []);

  const finalizeRole = useCallback(
    (role: ChatRole) => {
      const id = pendingIdsRef.current[role];
      if (!id) {
        return;
      }
      finalizeMessage(id);
      delete pendingIdsRef.current[role];
    },
    [finalizeMessage],
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

  useEffect(
    () => () => {
      stopVoiceSession();
    },
    [stopVoiceSession],
  );

  useEffect(() => {
    if (!open) {
      stopVoiceSession();
    }
  }, [open, stopVoiceSession]);

  const handleVoiceToggle = useCallback(() => {
    if (voiceStatus === 'active' || voiceStatus === 'connecting') {
      stopVoiceSession();
    } else {
      void startVoiceSession();
    }
  }, [startVoiceSession, stopVoiceSession, voiceStatus]);
  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = input.trim();
      const hasAttachments = attachments.length > 0;
      if ((trimmed.length === 0 && !hasAttachments) || busy) {
        return;
      }

      if (voiceStatus !== 'idle') {
        stopVoiceSession();
      }

      setBusy(true);
      setError(null);
      const displayContent = trimmed.length > 0 ? trimmed : hasAttachments ? '(Image attachment)' : '';
      const userMessage: WidgetMessage = {
        id: makeId(),
        role: 'user',
        content: displayContent,
        images: attachments.length > 0 ? attachments : undefined,
      };

      setMessages((prev) => [...prev, userMessage]);
      setInput('');
      setAttachments([]);

      try {
        const imagePayload =
          attachments.length > 0
            ? attachments.map((attachment) => ({
                data: attachment.url.split(',')[1] ?? '',
                mimeType: attachment.mimeType,
                name: attachment.name,
              }))
            : undefined;

        const request: ChatRequestBody = {
          message: trimmed,
          topicHint: props.topicHint,
          history: historyPayload,
          images: imagePayload,
        };
        const response: ChatResponseBody = await sendChatRequest(request);
        const assistantMessage: WidgetMessage = {
          id: makeId(),
          role: 'assistant',
          content: response.answer,
        };
        setMessages((prev) => [...prev, assistantMessage]);
      } catch (err) {
        setMessages((prev) => prev.filter((message) => message.id !== userMessage.id));
        setError(err instanceof Error ? err.message : 'Chat request failed');
      } finally {
        setBusy(false);
      }
    },
    [attachments, busy, historyPayload, input, props.topicHint, stopVoiceSession, voiceStatus],
  );

  const isVoiceConnecting = voiceStatus === 'connecting';
  const isVoiceActive = voiceStatus === 'active';

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

  const content = (
    <div className="wayfinder-widget">
      <button type="button" className="wayfinder-launcher" onClick={toggleOpen} data-open={open ? 'true' : 'false'}>
        {props.label ?? 'Wayfinder'}
      </button>
      {open ? (
        <div className="wayfinder-panel">
          <header className="wayfinder-panel__header">
            <h2>Wayfinder SoT</h2>
            <button type="button" onClick={toggleOpen} aria-label="Close Wayfinder chat">
              ×
            </button>
          </header>
          <div className="wayfinder-panel__body" ref={bodyRef}>
            <ul>
              {messages.map((message) => (
                <li key={message.id} data-role={message.role}>
                  <span>{message.content}</span>
                  {message.images && message.images.length > 0 ? (
                    <div className="wayfinder-message__images">
                      {message.images.map((image) => (
                        <figure key={image.id}>
                          <img src={image.url} alt={image.name} />
                          <figcaption>{image.name}</figcaption>
                        </figure>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
          <footer className="wayfinder-panel__footer">
            {error ? <p className="wayfinder-panel__error">{error}</p> : null}
            {voiceError ? <p className="wayfinder-panel__error">{voiceError}</p> : null}
            <form onSubmit={handleSubmit}>
              {voiceStatusLabel ? <p className={`wayfinder-voice-status status-${voiceStatus}`}>{voiceStatusLabel}</p> : null}
              <div className="wayfinder-attachments">
                {attachments.map((attachment) => (
                  <figure key={attachment.id}>
                    <img src={attachment.url} alt={attachment.name} />
                    <figcaption>{attachment.name}</figcaption>
                    <button type="button" onClick={() => handleRemoveAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`}>
                      ×
                    </button>
                  </figure>
                ))}
              </div>
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Type your question..."
                rows={2}
                disabled={busy}
                onPaste={handlePaste}
              />
              <div className="wayfinder-form-actions">
                <div className="wayfinder-form-button-group">
                  <button
                    type="button"
                    className="wayfinder-attach-button"
                    onClick={handleAttachmentButton}
                    disabled={attachments.length >= MAX_ATTACHMENTS || busy}
                  >
                    Attach image
                  </button>
                  <button
                    type="button"
                    className={`wayfinder-voice-button${isVoiceActive || isVoiceConnecting ? ' is-active' : ''}`}
                    onClick={handleVoiceToggle}
                    disabled={isVoiceConnecting || busy}
                    aria-pressed={isVoiceActive || isVoiceConnecting}
                    aria-label={isVoiceActive || isVoiceConnecting ? 'Stop voice session' : 'Start voice session'}
                    title={isVoiceActive || isVoiceConnecting ? 'Stop voice session' : 'Start voice session'}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path
                        fill="currentColor"
                        d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93V21h2v-2.07A7 7 0 0 0 19 12h-2z"
                      />
                    </svg>
                  </button>
                </div>
                <button type="submit" className="wayfinder-send-button" disabled={busy || (input.trim().length === 0 && attachments.length === 0)}>
                  {busy ? 'Thinking…' : 'Send'}
                </button>
              </div>
            </form>
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={handleFileChange} />
            <audio ref={audioRef} autoPlay className="wayfinder-voice-audio" />
          </footer>
        </div>
      ) : null}
    </div>
  );

  const portalTarget = typeof document !== 'undefined' ? document.body : null;
  return portalTarget ? createPortal(content, portalTarget) : content;
}
