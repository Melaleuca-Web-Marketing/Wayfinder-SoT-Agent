import { useEffect, useState } from 'react';

type StatusState = 'checking' | 'ok' | 'error';

export function ApiStatusFooter() {
  const [status, setStatus] = useState<StatusState>('checking');
  const [details, setDetails] = useState('');

  const checkStatus = async () => {
    setStatus('checking');
    try {
      const res = await fetch('/api/status');
      if (!res.ok) {
        throw new Error('Status endpoint failed');
      }
      const data = (await res.json()) as { ok: boolean; model?: string; error?: string };
      if (!data.ok) {
        throw new Error(data.error ?? 'API unreachable');
      }
      setStatus('ok');
      setDetails(`Model: ${data.model}`);
    } catch (error) {
      setStatus('error');
      setDetails(error instanceof Error ? error.message : 'Connection error');
    }
  };

  useEffect(() => {
    void checkStatus();
    const interval = window.setInterval(() => {
      void checkStatus();
    }, 60000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <footer className={`api-footer status-${status}`}>
      <span>
        API status:{' '}
        {status === 'checking' && 'Checking…'}
        {status === 'ok' && 'Connected'}
        {status === 'error' && 'Disconnected'}
      </span>
      <span className="details">{details}</span>
      <button type="button" onClick={() => void checkStatus()}>
        Recheck
      </button>
    </footer>
  );
}
