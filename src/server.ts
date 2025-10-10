import { createApp } from './app';

const PORT = process.env.PORT ? Number(process.env.PORT) : 4001;
const app = createApp();

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
