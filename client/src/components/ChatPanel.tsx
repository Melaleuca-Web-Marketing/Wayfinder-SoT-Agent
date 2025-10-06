import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';

type Role = 'user' | 'assistant';

interface ChatTurn {
  id: string;
  role: Role;
  content: string;
  streaming?: boolean;
}

interface ChatResponse {
  answer: string;
}

type VoiceStatus = 'idle' | 'connecting' | 'active';

const makeId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));

const formatMessage = (content: string) => {
  return content.split('\n').map((line, index) => (
    <p key={index}>{line || '\u00a0'}</p>
  ));
};

export function ChatPanel() {
  const [topicHint, setTopicHint] = useState<'melaleuca' | 'riverbend'>('melaleuca');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingIdsRef = useRef<{ user?: string; assistant?: string }>({});

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, voiceStatus]);

  useEffect(() => {
    return () => {
      stopVoiceSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (!input.trim() || loading) {
        return;
      }

      const message = input.trim();
      setInput('');
      setError(null);

      const history = [...messages];
      const userMessage: ChatTurn = { id: makeId(), role: 'user', content: message };
      const nextMessages = [...history, userMessage];
      setMessages(nextMessages);
      setLoading(true);

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message,
            topicHint,
            history,
          }),
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error ?? 'Chat request failed');
        }

        const data = (await response.json()) as ChatResponse;
        setMessages([...nextMessages, { id: makeId(), role: 'assistant', content: data.answer }]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Chat request failed');
      } finally {
        setLoading(false);
      }
    },
    [input, loading, messages, topicHint],
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

      const tokenResponse = await fetch('/api/realtime/token', { method: 'POST' });
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
          <button type="button" onClick={handleVoiceToggle} disabled={isVoiceConnecting}>
            {isVoiceActive || isVoiceConnecting ? 'Stop voice' : 'Start voice'}
          </button>
          <button type="button" onClick={() => setMessages([])} disabled={loading}>
            Clear history
          </button>
        </div>
      </header>

      {voiceStatusLabel && <div className={`chat-voice-status status-${voiceStatus}`}>{voiceStatusLabel}</div>}

      <div className="chat-transcript">
        {messages.length === 0 && !loading && <p className="empty">Ask something to get started.</p>}
        {messages.map((turn, index) => (
          <div key={turn.id ?? index} className={`chat-turn ${turn.role} ${turn.streaming ? 'streaming' : ''}`}>
            <div className="chat-role">{turn.role === 'user' ? 'You' : 'Assistant'}</div>
            <div className="chat-content">{formatMessage(turn.content)}</div>
          </div>
        ))}
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
          placeholder="Ask a question about Melaleuca or Riverbend Ranch…"
          rows={3}
          disabled={loading}
        />
        <div className="chat-form-actions">
          <button type="submit" disabled={loading || !input.trim()}>
            Send
          </button>
        </div>
      </form>

      <audio ref={audioRef} autoPlay className="voice-audio" />
    </section>
  );
}
