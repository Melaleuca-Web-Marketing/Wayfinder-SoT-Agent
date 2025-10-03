import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { ask } from './ask';
import { getVectorStoreDetails, listVectorStoreFiles, uploadFileToVectorStore, deleteVectorStoreFile, ensureVectorStoreId, vectorStoreClient } from './vectorStore';
import { settings } from './config';

const app = express();
const uploadsDir = path.resolve('.uploads');
fsSync.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir });
const PORT = process.env.PORT ? Number(process.env.PORT) : 4001;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/api/status', async (_req, res) => {
  try {
    const modelInfo = await vectorStoreClient.models.retrieve(settings.model);
    res.json({ ok: true, model: modelInfo.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ ok: false, error: message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { message, topicHint, history } = req.body ?? {};
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  try {
    const vectorStoreId = await ensureVectorStoreId();
    const result = await ask({
      message,
      topicHint,
      history: Array.isArray(history)
        ? history
            .map((item: any) => ({
              role: item?.role,
              content: typeof item?.content === 'string' ? item.content : '',
            }))
            .filter((item) => item.role === 'user' || item.role === 'assistant')
        : [],
      vectorStoreIds: [vectorStoreId],
    });

    res.json({
      answer: result.answer,
      response: result.response,
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: messageText });
  }
});

app.get('/api/vector/store', async (_req, res) => {
  try {
    const data = await getVectorStoreDetails();
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

app.get('/api/vector/files', async (_req, res) => {
  try {
    const files = await listVectorStoreFiles();
    res.json({ files });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

app.post('/api/vector/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'file is required' });
    return;
  }

  const localPath = req.file.path;
  const filename = req.file.originalname;

  try {
    const result = await uploadFileToVectorStore(localPath, filename);
    res.status(201).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  } finally {
    await fs.rm(localPath, { force: true });
  }
});

app.delete('/api/vector/files/:fileId', async (req, res) => {
  const { fileId } = req.params;
  if (!fileId) {
    res.status(400).json({ error: 'fileId is required' });
    return;
  }

  try {
    await deleteVectorStoreFile(fileId);
    res.status(204).end();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

if (process.env.NODE_ENV === 'production') {
  const clientBuildPath = path.resolve('client', 'dist');
  app.use(express.static(clientBuildPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientBuildPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
