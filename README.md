# Wayfinder SoT Agent

Wayfinder SoT (Source-of-Truth) Agent is a full-stack toolkit for building web-first retrieval assistants. It combines an OpenAI Responses API back end, vector-store management APIs, and a React “control center” UI so teams can ground chat answers in first-party sources, ingest new documents, and monitor connectivity in one place.

A Node.js / TypeScript implementation of the web-first retrieval flow described in `knowledge_foundation_responses_api_melaleuca_riverbend_ranch.md`. The default configuration prioritises Melaleuca-owned domains via the OpenAI Responses API, falls back to vector stores only when needed, and emits citations for every answer, but you can swap the domain heuristics for any other property.

## Prerequisites

- Node.js 20+
- An OpenAI API key with access to the Responses API + web search preview

## Setup

```bash
cp .env.example .env
# edit .env with your credentials and domain overrides if needed
npm install
npm install --prefix client
```

## Local Development

Run the full stack (API server + Vite UI) in watch mode (API defaults to port 4001):

```bash
npm run dev
```

The backend listens on `http://localhost:4001` and the UI on `http://localhost:5173` (proxied to the API during dev).

## Production Build & Serve

```bash
npm run build        # builds server + web assets
npm start            # serves API + compiled UI (NODE_ENV=production)
```

## CLI & SDK Usage

Run an interactive question:

```bash
npm run dev:ask -- "How do I become a Melaleuca customer?"
```

Use a topic hint when you already know the vertical:

```bash
npm run dev:ask -- --hint riverbend "What is Riverbend Ranch Beef?"
```

Build once for production use:

```bash
npm run build
node dist/cli.js -- "Show me Melaleuca's loyalty programs"
```

## Evaluations

Golden QA checks ensure citations stay on the correct domains:

```bash
npm run eval
```

Each case asserts that at least one cited URL starts with the required domain. Add more questions to `eval/golden_qa.jsonl` as new topics launch.

## Vector Store Management & UI

- When the server starts it will look for `VECTOR_STORE_ID` in `.env`. If none is provided it creates a new vector store and caches the ID in `.vector-store.json`.
- Visit the Documents tab in the UI to upload PDF/Markdown assets. Files are streamed to OpenAI, attached to the vector store, and listed with their indexing status.
- The Chat tab provides a conversational harness that shares context with the vector store and enforces on-domain sourcing. Every answer ends with a `Sources` block.
- The footer pings the OpenAI API once per minute (and on demand) to confirm connectivity and the active model.

## Security Guardrails (MVP)

The API layer adds baseline protections so prompt/response handling stays on-brand:

- **Input caps:** messages longer than `MAX_MESSAGE_CHARS` (default 2,000) or containing more than `MAX_MESSAGE_URLS` (default 20) are rejected.
- **Moderation + scope guard:** prompts flow through `omni-moderation-latest` and a simple keyword scope filter before any model call.
- **Rate limits:** per-minute (`RATE_LIMIT_PER_MINUTE`, default 10) and per-day (`RATE_LIMIT_PER_DAY`, default 200) throttles via `express-rate-limit`.
- **Output enforcement:** `ask()` clamps `max_output_tokens` (default 6,000) while forcing a `Sources:` section. Answers missing an allowlisted Melaleuca URL (or a file citation) fall back to the canonical site URL.

Tweak the `.env` knobs to adjust these guardrails as you scale.

## Voice Mode (Realtime API)

- Text chat defaults to GPT-5 (`OPENAI_MODEL`, override as needed).
- Click **Start voice** in the Chat panel to launch a WebRTC session with the OpenAI Realtime API (`REALTIME_MODEL`, default `gpt-4o-realtime-preview-2024-12-17`).
- The browser captures microphone input, streams it to the model, and plays synthesized audio replies while streaming transcripts into the existing chat window (including Sources when returned).
- Use **Stop voice** to end the session; transcripts remain in history alongside typed messages for easy follow-up.
- Configure voice defaults via `REALTIME_VOICE` and reuse the same security guardrails enforced for text requests.
