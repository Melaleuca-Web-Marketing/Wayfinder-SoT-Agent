import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

type Role = 'user' | 'assistant';

interface ChatTurn {
  role: Role;
  content: string;
}

interface ChatResponse {
  answer: string;
}

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
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

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
      const nextMessages = [...history, { role: 'user' as Role, content: message }];
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
        setMessages([...nextMessages, { role: 'assistant', content: data.answer }]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Chat request failed');
      } finally {
        setLoading(false);
      }
    },
    [input, loading, messages, topicHint],
  );

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
          <button type="button" onClick={() => setMessages([])} disabled={loading}>
            Clear history
          </button>
        </div>
      </header>

      <div className="chat-transcript">
        {messages.length === 0 && !loading && <p className="empty">Ask something to get started.</p>}
        {messages.map((turn, index) => (
          <div key={index} className={`chat-turn ${turn.role}`}>
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
    </section>
  );
}
