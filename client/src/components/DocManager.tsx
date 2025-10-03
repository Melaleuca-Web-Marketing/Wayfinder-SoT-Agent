import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEventHandler } from 'react';

interface VectorStoreInfo {
  id: string;
  name: string;
  file_count: number;
}

interface VectorStoreFile {
  id: string;
  status: string;
  name: string;
  created_at: number | null;
  last_error: string | null;
}

const formatDate = (timestamp: number | null) => {
  if (!timestamp) {
    return '—';
  }
  const ms = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(ms).toLocaleString();
};

export function DocManager() {
  const [info, setInfo] = useState<VectorStoreInfo | null>(null);
  const [files, setFiles] = useState<VectorStoreFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [storeRes, filesRes] = await Promise.all([
        fetch('/api/vector/store'),
        fetch('/api/vector/files'),
      ]);

      if (!storeRes.ok) {
        throw new Error(`Vector store error: ${(await storeRes.json()).error ?? storeRes.statusText}`);
      }
      if (!filesRes.ok) {
        throw new Error(`Vector files error: ${(await filesRes.json()).error ?? filesRes.statusText}`);
      }

      const storeData = (await storeRes.json()) as VectorStoreInfo;
      const filesData = (await filesRes.json()) as { files: VectorStoreFile[] };
      setInfo(storeData);
      setFiles(filesData.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load vector store data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleUpload: FormEventHandler<HTMLFormElement> = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fileInput = form.elements.namedItem('file') as HTMLInputElement | null;
    const file = fileInput?.files?.[0];

    if (!file) {
      setError('Please choose a file to upload.');
      return;
    }

    setUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/vector/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Upload failed');
      }

      form.reset();
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = useCallback(
    async (fileId: string) => {
      if (!confirm('Remove this file from the vector store?')) {
        return;
      }

      setError(null);
      try {
        const res = await fetch(`/api/vector/files/${fileId}`, {
          method: 'DELETE',
        });

        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error ?? 'Delete failed');
        }

        await fetchData();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Delete failed');
      }
    },
    [fetchData],
  );

  const statusSummary = useMemo(() => {
    if (!files.length) {
      return 'No documents uploaded yet.';
    }
    const queued = files.filter((file) => file.status !== 'completed');
    if (queued.length === 0) {
      return 'All documents indexed. You can add more at any time.';
    }
    return `${queued.length} document(s) still processing…`;
  }, [files]);

  return (
    <section className="doc-manager">
      <header>
        <h2>Vector Store</h2>
        <button type="button" onClick={() => void fetchData()} disabled={loading}>
          Refresh
        </button>
      </header>

      {error && <div className="doc-error">{error}</div>}

      {info && (
        <div className="doc-info">
          <p>
            <strong>ID:</strong> <code>{info.id}</code>
          </p>
          <p>
            <strong>Name:</strong> {info.name}
          </p>
          <p>
            <strong>Total Files:</strong> {info.file_count}
          </p>
        </div>
      )}

      <form className="upload-form" onSubmit={handleUpload}>
        <label className="file-input">
          <span>Upload PDF or Markdown</span>
          <input type="file" name="file" accept=".pdf,.md,.txt" required disabled={uploading} />
        </label>
        <button type="submit" disabled={uploading}>
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </form>

      <p className="doc-status">{statusSummary}</p>

      <div className="doc-table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Added</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4}>Loading…</td>
              </tr>
            ) : files.length === 0 ? (
              <tr>
                <td colSpan={4}>No files in the vector store.</td>
              </tr>
            ) : (
              files.map((file) => (
                <tr key={file.id}>
                  <td>{file.name}</td>
                  <td>
                    <span className={`status status-${file.status}`}>{file.status}</span>
                    {file.last_error && <small className="status-error">{file.last_error}</small>}
                  </td>
                  <td>{formatDate(file.created_at)}</td>
                  <td>
                    <button type="button" onClick={() => void handleDelete(file.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
