import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, FormEvent } from 'react';
import {
  sendChatRequest,
  fetchRealtimeToken,
  type ChatRequestBody,
  type ChatResponseBody,
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

export function ChatPanel() {
  const [topicHint, setTopicHint] = useState<'melaleuca' | 'riverbend'>('melaleuca');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, voiceStatus]);

  useEffect(() => {
    return () => {
      stopVoiceSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      const historyPayload = messages.map((turn) => ({
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

      const nextMessages = [...messages, userMessage];
      setMessages(nextMessages);
      setAttachments([]);
      setLoading(true);

      try {
        const requestBody: ChatRequestBody = {
          message: trimmed,
          topicHint,
          history: historyPayload,
          images: imagePayload,
        };
        const data: ChatResponseBody = await sendChatRequest(requestBody);
        setMessages([...nextMessages, { id: makeId(), role: 'assistant', content: data.answer }]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Chat request failed');
      } finally {
        setLoading(false);
      }
    },
    [attachments, input, loading, messages, topicHint],
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

  return (
    <section className="chat-panel">
      <header>
        <h2>Knowledge Chat</h2>
        <div className="chat-controls">
          <label>
            Domain focus
            <select value={topicHint} onChange={(event) => setTopicHint(event.target.value as typeof topicHint)}>
              <option value="melaleuca">Melaleuca</option>
              <option value="riverbend">Riverbend Ranch</option>
            </select>
          </label>
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
          const content = formatMessage(turn.content);
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
              </div>
            </div>
          );
        })}
        {loading && (
          <div className="chat-turn assistant">
            <div className="chat-role">Assistant</div>
            <div className="chat-content">Thinking…</div>
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
