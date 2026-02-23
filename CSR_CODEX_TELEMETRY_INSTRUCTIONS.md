# CSR Codex Integration Instructions (Telemetry + Ratings)

Use this guide in the CSR project to wire into the backend at `https://wayfinder-so-t-agent.vercel.app`.

## Goal

Add three behaviors to the CSR chat client:

1. Show response time per assistant answer (example: `29s`).
2. Show thumbs up/down per assistant answer.
3. Persist session, turn, response time, and rating to backend telemetry endpoints.

## Backend Endpoints

All endpoints are under `/api`.

- `POST /api/telemetry/session`
- `POST /api/telemetry/turn`
- `POST /api/telemetry/feedback`
- `GET /api/telemetry/sessions?limit=50`
- `GET /api/telemetry/sessions/:sessionId`

Main chat remains:

- `POST /api/chat`

## Request Contracts

### 1) Start session

`POST /api/telemetry/session`

Body:

```json
{
  "agentProfile": "csr",
  "clientApp": "csr-web",
  "clientSessionId": "<browser-generated-uuid>",
  "metadata": {
    "build": "<optional app version>"
  }
}
```

Response:

```json
{
  "sessionId": "<uuid>",
  "createdAt": "<iso>"
}
```

### 2) Store turn after each assistant response

`POST /api/telemetry/turn`

Body:

```json
{
  "sessionId": "<sessionId>",
  "question": "What product is good for heart health?",
  "answer": "...assistant answer text...",
  "responseMs": 29000,
  "model": "gpt-4.1",
  "topicHint": "melaleuca",
  "responseId": "resp_...",
  "requestedAt": "2026-02-23T23:10:00.000Z",
  "respondedAt": "2026-02-23T23:10:29.000Z",
  "metadata": {
    "windowMode": "incognito"
  }
}
```

Response:

```json
{
  "turnId": "<uuid>",
  "createdAt": "<iso>"
}
```

Store `turnId` on that assistant message in client state.

### 3) Store feedback

`POST /api/telemetry/feedback`

Thumbs up body:

```json
{
  "turnId": "<turnId>",
  "rating": "up"
}
```

Thumbs down body:

```json
{
  "turnId": "<turnId>",
  "rating": "down",
  "comment": "Missed the US product page and cited a non-US source."
}
```

Response:

```json
{
  "turnId": "<turnId>",
  "rating": "up",
  "updatedAt": "<iso>"
}
```

## UI Behavior

### Response time label

- Capture `requestedAt = Date.now()` right before `POST /api/chat`.
- Capture `respondedAt = Date.now()` when chat response resolves.
- Compute `responseMs = respondedAt - requestedAt`.
- Render under source chips as a subtle label, e.g. `29s`.
- Persist this value via `POST /api/telemetry/turn`.

### Thumbs controls

- Render `👍` and `👎` on each assistant message after it is saved as a telemetry turn.
- `👍`: send `rating=up` immediately.
- `👎`: open inline textarea and submit button.
- Require non-empty comment for `👎` before posting.
- Disable controls while request is in flight.
- Optionally allow replacing prior rating (backend upserts by `turnId`).

## Recommended Client Flow

1. On app load, create one telemetry session and keep `sessionId` in memory.
2. On each user send:
   - record timestamp start,
   - call `/api/chat`,
   - record timestamp end,
   - render assistant answer + response time,
   - call `/api/telemetry/turn`,
   - attach returned `turnId` to the message object.
3. On thumbs click, call `/api/telemetry/feedback` with that `turnId`.

## Error Handling

- If telemetry fails, do not block chat UX.
- Show a quiet console warning and continue.
- If session create fails, retry once, then continue with chat only.

## Quick Smoke Test

1. Ask one question in CSR UI.
2. Confirm response-time label appears.
3. Send thumbs down with a comment.
4. Verify backend review data:
   - `GET /api/telemetry/sessions?limit=10`
   - `GET /api/telemetry/sessions/<sessionId>`
