# Phase 2 Spec: True Token Streaming (With Source Verification Safety)

## Scope
Implement true assistant token streaming for chat responses while preserving existing guardrails:
- source allowlist enforcement
- retry-on-source-fallback behavior
- final validated answer semantics

This spec is for backend + admin/CSR clients. No implementation is included in this document.

## Why This Is Phase 2
Phase 1 added status/progress streaming (low risk). Phase 2 streams actual answer tokens, which is harder because current backend may replace the initial model answer after verification/retry.

## Goals
1. Improve perceived latency by showing answer text within ~1 second when upstream permits.
2. Preserve answer quality and allowlist safety.
3. Keep compatibility with current non-stream endpoint (`/api/chat`).
4. Support both Admin and CSR clients.

## Non-Goals
1. Removing source verification/retry safety logic.
2. Replacing realtime voice pathway.
3. Redesigning telemetry schema beyond streaming metrics additions.

## Current Baseline (As of this branch)
- `/api/chat`: final JSON only.
- `/api/chat/progress`: NDJSON statuses + final result.
- `ask()` may run retries when source checks fail.
- Allowlist enforcement can replace final answer with fallback.

## Proposed API Contract
Add a new endpoint:
- `POST /api/chat/stream`

Keep request body identical to `/api/chat`.

Response content type:
- `application/x-ndjson; charset=utf-8`

Event envelope (one JSON object per line):
- `status`: phase updates.
- `delta`: token chunks for an in-flight draft answer.
- `revision`: indicates draft replacement started.
- `result`: final validated payload (same shape as `/api/chat`).
- `error`: terminal error.
- `done`: terminal marker.

### Event Types
1. Status
```json
{ "type": "status", "stage": "moderating|retrieving|drafting|verifying|finalizing", "message": "...", "timestamp": "..." }
```

2. Token delta
```json
{ "type": "delta", "draftId": "draft_1", "text": "next token chunk", "timestamp": "..." }
```

3. Draft revision start (when retry/replacement occurs)
```json
{ "type": "revision", "fromDraftId": "draft_1", "toDraftId": "draft_2", "reason": "source_retry|allowlist_replace", "timestamp": "..." }
```

4. Final result
```json
{ "type": "result", "payload": { "answer": "...", "response": { ... }, "responseId": "...", "metrics": { ... } }, "timestamp": "..." }
```

5. Error
```json
{ "type": "error", "error": "message", "timestamp": "..." }
```

6. Done
```json
{ "type": "done", "timestamp": "..." }
```

## Behavioral Semantics
### Draft vs Final
- `delta` events represent a draft that may be revised.
- Client must treat `result.payload.answer` as source of truth.
- If no revision occurs, final answer should match the streamed draft text.
- If revision occurs, client can either:
  - replace draft text in-place with revised draft stream, or
  - show “Revising answer…” and then swap to final answer on `result`.

### Retry Path
- If source verification fails initial pass:
  - emit `status` verifying/re-checking
  - emit `revision` (`draft_1` -> `draft_2`)
  - stream retry pass deltas as `draft_2`
  - emit final `result`

### Hard Fallback Path
- If allowlist still fails:
  - emit `revision` with reason `allowlist_replace` (if draft had content)
  - emit final fallback answer via `result`

## Backend Design
### 1) New ask-stream orchestration
Introduce a streaming-capable orchestration path (suggested new module):
- `src/askStream.ts`

Responsibilities:
1. Build prompts/tools exactly as current `ask()` path.
2. OpenAI Responses with streaming enabled for pass 1.
3. Emit `delta` events from model output text chunks.
4. Buffer full pass output server-side for source verification.
5. If retry needed, open a second stream and emit `revision` + second-pass `delta`.
6. Return final validated payload + metrics.

### 2) Keep shared verification logic centralized
Refactor common verification helpers to avoid divergence:
- source extraction
- allowlist checks
- fallback generation

Goal: non-stream and stream modes produce equivalent final answers.

### 3) Add endpoint
In `src/app.ts`:
- add `POST /api/chat/stream`
- use NDJSON writer utilities
- map internal progress to `status` events
- flush at each event

### 4) Feature flag
Add env flag:
- `ENABLE_CHAT_TOKEN_STREAMING`
  - default: `false`
  - when false: endpoint returns 404 or explicit error

Optional scoping flags:
- `ENABLE_CHAT_TOKEN_STREAMING_ADMIN_ONLY=true`
- `ENABLE_CHAT_TOKEN_STREAMING_CSR=true`

## Client Design
### Admin + CSR shared requirements
1. Add stream parser for `delta/revision/result/error/done` events.
2. Render a draft bubble during `delta`.
3. Handle `revision` by switching active draft buffer.
4. On `result`, commit final answer and use it for transcript/source chips.
5. Preserve existing error handling and telemetry calls.

### Suggested UX copy
- During initial stream: “Drafting response…”
- On revision: “Re-checking sources and revising answer…”
- On final: remove draft badge/state.

## Metrics & Telemetry
Add (or derive) these metrics in response/logs:
1. `timeToFirstDeltaMs`
2. `timeToFirstResultMs`
3. `draftRevisionCount`
4. `streamedCharsPass1`
5. `streamedCharsPass2`
6. Existing stage timings/retry summary retained.

For telemetry turn metadata (optional extension):
- `streamMode: true`
- `timeToFirstDeltaMs`
- `draftRevisionCount`

## Backward Compatibility
- `/api/chat` remains unchanged and fully supported.
- `/api/chat/progress` remains for low-risk status-only path.
- New `/api/chat/stream` is additive.

## Rollout Plan
1. Ship backend stream endpoint behind feature flag (disabled).
2. Enable for internal Admin only.
3. Validate logs/metrics + source quality.
4. Enable CSR in staged fashion.
5. Keep `/api/chat/progress` as fallback path during rollout.

## Testing Plan
### Unit
1. NDJSON event writer and parser.
2. source allowlist verification parity with non-stream mode.
3. revision handling behavior.

### Integration
1. stream success without retry.
2. stream with retry revision.
3. stream with allowlist fallback replacement.
4. stream error path mid-flight.

### UX smoke
1. Text-only prompt with fast first delta.
2. Image prompt.
3. Prompt triggering retry path.
4. Prompt triggering hard fallback.

## Risks and Mitigations
1. Risk: draft text differs from final answer.
- Mitigation: explicit draft semantics + revision event + final authoritative result.

2. Risk: client/parser bugs on partial chunks.
- Mitigation: shared stream parser utility and integration tests.

3. Risk: complexity drifts from current behavior.
- Mitigation: reuse existing verification helpers; diff final answers between modes in QA.

## Estimated Lift
- Backend stream orchestration + endpoint: 2-3 days
- Client integration (admin + CSR): 1-2 days
- QA and rollout hardening: 1-2 days

Total: ~4-7 working days.

## Branching / Delivery
- Implement on dedicated feature branch (recommended): `feature/phase2-token-streaming`
- Merge only after parity + rollback checks pass.
