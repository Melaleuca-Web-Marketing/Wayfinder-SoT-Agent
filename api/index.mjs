import { createApp } from '../dist/serverless/app.mjs';

let app;

export default function handler(req, res) {
  if (!app) {
    app = createApp();
  }
  return app(req, res);
}
