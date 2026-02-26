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
- URL imports can optionally send authenticated cookies for private pages. For Vercel, set:
  - `VECTOR_URL_AUTH_MODE=cookie`
  - `VECTOR_URL_AUTH_DOMAIN=melaleuca.com` (or a narrower host)
  - `VECTOR_URL_AUTH_COOKIE=<cookie header value>`
  - Optional local fallback: `VECTOR_URL_AUTH_COOKIE_FILE=authcookie.sh`
- The Chat tab provides a conversational harness that shares context with the vector store and enforces on-domain sourcing. Every answer ends with a `Sources` block.
- The Chat tab now supports image attachments—paste or upload up to three screenshots (PNG/JPEG/WebP) per turn to pair vision context with your question.
- The `widget` package builds a portable Wayfinder popup chat that embeds on marketing sites while riding on the same `/api` backend and vector store. Run `npm run dev --prefix widget` to preview the popup locally.
- The footer pings the OpenAI API once per minute (and on demand) to confirm connectivity and the active model.

## HTTP API Endpoints

The backend exposes JSON endpoints under `/api` so any client (admin UI, widget, service integration) can share the same agent state.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/status` | Health probe. Returns `{ ok: true, model: "<id>" }` when the OpenAI Responses API is reachable. |
| `POST` | `/api/chat` | Main chat endpoint. Body: `{ message: string, topicHint?: "melaleuca" \| "riverbend", history?: ConversationTurn[], images?: Base64Image[], vectorStoreIds?: string[], previousResponseId?: string, agentProfile?: "admin" \| "csr", adminModelPreset?: "gpt-4.1" \| "gpt-5.1-none" \| "gpt-5.1-low" }`. Responds with `{ answer, response, responseId, metrics }`, where `response` is the raw Responses API payload (including tool calls and citations) and `metrics` includes stage timings/retry counters for latency analysis. `adminModelPreset` overrides the backend default model for both `admin` and `csr` profile calls. |
| `POST` | `/api/chat/progress` | NDJSON progress stream for admin UX. Same body as `/api/chat`. Emits status events (`moderating`, `retrieving`, `drafting`, `verifying`, `finalizing`) and a final `result` event containing the same payload as `/api/chat`. |
| `POST` | `/api/chat/stream` | NDJSON token stream. Same body as `/api/chat`. Emits `status`, `delta`, `revision`, `result`, `error`, and `done` events. `result.payload.answer` remains the source of truth if a draft is revised/replaced. Guarded by `ENABLE_CHAT_TOKEN_STREAMING` flags. |
| `POST` | `/api/telemetry/session` | Starts a chat-review session. Body: `{ agentProfile?: string, clientApp?: string, clientSessionId?: string, metadata?: object }`. Responds with `{ sessionId, createdAt }`. |
| `POST` | `/api/telemetry/turn` | Stores one Q/A turn. Body: `{ sessionId, question, answer, responseMs?: number, model?: string, topicHint?: string, responseId?: string, requestedAt?: ISOString, respondedAt?: ISOString, metadata?: object }`. Responds with `{ turnId, createdAt }`. |
| `POST` | `/api/telemetry/feedback` | Stores thumbs feedback for a turn. Body: `{ turnId, rating: "up" \| "down", comment?: string }`. For `down`, comment is required. Responds with `{ turnId, rating, updatedAt }`. |
| `GET` | `/api/telemetry/sessions?limit=50` | Lists recent sessions with rollups (`turnCount`, `thumbsUpCount`, `thumbsDownCount`, `lastTurnAt`). |
| `GET` | `/api/telemetry/sessions/:sessionId` | Returns one session plus ordered turns and attached feedback entries. |
| `POST` | `/api/realtime/token` | Creates a short-lived Realtime session for voice calls. The widget/admin UI exchanges the token with the browser Realtime SDK. |
| `GET` | `/api/vector/store` | Returns the active vector store metadata (`{ id, name, file_count }`). |
| `GET` | `/api/vector/files` | Lists the most recent files attached to the store with status + error fields. |
| `POST` | `/api/vector/upload` | Multipart upload (`file` field) for PDFs/Markdown. Streams the document to OpenAI, attaches it to the active vector store, and returns both the OpenAI file id and vector-store-file id. |
| `DELETE` | `/api/vector/files/:fileId` | Removes a document from the active vector store. |

All endpoints require the same `.env` configuration described earlier (`OPENAI_API_KEY`, vector store settings, rate-limit knobs). Telemetry storage uses `TELEMETRY_DATABASE_URL` when set (recommended for Vercel), otherwise it falls back to a local JSON file (`TELEMETRY_FILE_PATH` or `.telemetry/telemetry-store.json` in local dev). During development the admin UI proxies calls to `localhost:4001`, so you can test against these endpoints with tools like `curl` or Postman.

For CSR frontend wiring details (response-time UI + thumbs + telemetry posting), use `CSR_CODEX_TELEMETRY_INSTRUCTIONS.md`.

## Security Guardrails (MVP)

The API layer adds baseline protections so prompt/response handling stays on-brand:

- **Input caps:** messages longer than `MAX_MESSAGE_CHARS` (default 2,000) or containing more than `MAX_MESSAGE_URLS` (default 20) are rejected.
- **Attachment caps:** per-message vision uploads are limited by `MAX_MESSAGE_IMAGES` (default 3) and `MAX_IMAGE_BYTES` (default 4 MB each).
- **Moderation + scope guard:** prompts flow through `omni-moderation-latest` and a simple keyword scope filter before any model call.
- **Rate limits:** per-minute (`RATE_LIMIT_PER_MINUTE`, default 10) and per-day (`RATE_LIMIT_PER_DAY`, default 200) throttles via `express-rate-limit`. Set `DISABLE_RATE_LIMITS=true` for internal testing environments.
- **Output enforcement:** `ask()` clamps `max_output_tokens` (default 6,000) while forcing a `Sources:` section. Answers missing an allowlisted Melaleuca URL (or a file citation) fall back to the canonical site URL.
- **OpenAI request policy:** set `OPENAI_REQUEST_TIMEOUT_MS` (default 60,000) and `OPENAI_MAX_RETRIES` (default 0) to control timeout/fail-fast behavior explicitly.
- **Token stream gating:** set `ENABLE_CHAT_TOKEN_STREAMING=true` to enable `/api/chat/stream`, optionally scope with `ENABLE_CHAT_TOKEN_STREAMING_ADMIN_ONLY` and `ENABLE_CHAT_TOKEN_STREAMING_CSR`.
- **US host strictness (recommended):** set `WEB_SEARCH_ALLOWED_DOMAINS=www.melaleuca.com,cdnsc1.melaleuca.com` to avoid locale subdomain drift (`sg.`, `tw.`, etc.) in web-search retrieval.
  - If `melaleuca.com` (or wildcard variants) is configured, the server now auto-tightens web-search hosts to `www.melaleuca.com` + `cdnsc1.melaleuca.com`.

Tweak the `.env` knobs to adjust these guardrails as you scale.

## Voice Mode (Realtime API)

- Text chat defaults to GPT-4.1 (`OPENAI_MODEL`, override as needed).
- Click **Start voice** in the Chat panel to launch a WebRTC session with the OpenAI Realtime API (`REALTIME_MODEL`, default `gpt-4o-realtime-preview-2024-12-17`).
- The browser captures microphone input, streams it to the model, and plays synthesized audio replies while streaming transcripts into the existing chat window (including Sources when returned).
- Use **Stop voice** to end the session; transcripts remain in history alongside typed messages for easy follow-up.
- Configure voice defaults via `REALTIME_VOICE` and reuse the same security guardrails enforced for text requests.

_Deployment note: updated on February 17, 2026 to trigger a new Vercel deployment._
