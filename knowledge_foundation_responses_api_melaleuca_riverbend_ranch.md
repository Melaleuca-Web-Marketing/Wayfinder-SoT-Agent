# Web‑First Knowledge Foundation (Responses API)

**Owner:** Richard Klaver (@rklaver)\
**Targets:** Melaleuca, Riverbend Ranch / Riverbend Ranch Beef, R3 Weight Loss Plan\
**Primary model (configurable):** `gpt-5` (default) → overrideable per env\
**Objective:** Ship an agent back‑end that answers with **web search first** (melaleuca.com prioritized), then **file search** fallback (vector stores). If neither yields a grounded answer, **direct the user to the correct website URL**.

---

## 1) Sources of truth & priority

**Priority order per question:**

1. **Web Search (must prefer first‑party domains)**\
   • Melaleuca topics → search [**https://www.melaleuca.com/**](https://www.melaleuca.com/) first.\
   • Riverbend topics → search [**https://www.melaleuca.com/riverbendranch**](https://www.melaleuca.com/riverbendranch) first.\
   • R3 Weight Loss Plan → search [**https://www.melaleuca.com/r3**](https://www.melaleuca.com/r3) first.\
   • **Do not use broader web for Melaleuca or Riverbend topics.** If first‑party pages don’t cover the query, do not answer from external sources—return the website fallback with the canonical URL instead.
3. **File Search (vector stores)** — used **only if** web search produces no satisfactory, citable result.
4. **If still no answer:** Return a short fallback pointing users to the relevant site path (e.g., “Please check [**https://www.melaleuca.com/riverbendranch**](https://www.melaleuca.com/riverbendranch) for the latest details.”).

**Result policy:** Every answer must include a **Sources** list with one or more URLs (from web search) or document IDs (from file search). If both are used, list web URLs first.

---

## 2) Architecture (runtime flow)

**ask() high‑level:**

1. Build a system prompt that enforces: (a) web‑first retrieval with domain allowlists, (b) citation requirements, (c) safe fallback.
2. Call **Responses API** with tools `[web_search, file_search]` — **no custom tools needed for v1**.
3. Pass **web\_search arguments** with **domain allowlist** and **query rewrite** (prepend `site:melaleuca.com` or `site:melaleuca.com/riverbendranch` when appropriate).
4. If the model calls `web_search` and returns high‑confidence results → synthesize answer **only** from those pages and cite URLs.
5. If the model returns **no/low** confidence web results → allow a **second tool call** to `file_search` (bound to our vector\_store).
6. If neither yields adequate evidence → emit fallback message with the **exact canonical URL** to check.

**Confidence gates (first pass):**

- Treat web search as “adequate” if: ≥1 on‑domain URL retrieved **and** content snippets contain the asked entities/terms.
- Otherwise, attempt `file_search` (top‑k 5). If still weak → fallback.

**Caching (optional v1.1):** Cache normalized HTML → plaintext extracts for melaleuca.com URLs for 24h to reduce latency and rate‑limits.

---

## 3) System prompt (template)

> You are Melaleuca’s web‑first knowledge agent. Follow these rules strictly:
>
> **Retrieval order**
>
> 1. Use **web\_search** first. For queries about Melaleuca, prefer **melaleuca.com**. For Riverbend Ranch / Beef, prefer **melaleuca.com/riverbendranch**. Only leave these domains if no relevant first‑party results are found.
> 2. If web results are weak, call **file\_search** on the provided vector store(s).
> 3. If both fail, respond with: “I couldn’t confirm from our site or files. Please check: .”
>
> **Grounding & citations**
>
> - Synthesize answers **only** from retrieved sources.
> - Always include a **Sources** section listing the exact URLs (or doc titles + canonical\_id for files).
> - Never guess policy, pricing, or availability. Ask a brief clarifying question only if a key attribute (e.g., region, product, language) is missing.
>
> **Domain selection heuristics**
>
> - If the query mentions “riverbend” or “beef”, search `site:melaleuca.com/riverbendranch` first.
> - Else search `site:melaleuca.com` first.
> - **Never use broader web for company/product questions.** If no on‑domain evidence exists, fail closed and return the canonical URL. (Optional future: allow a curated off‑domain allowlist for non‑company general‑knowledge questions only, guarded by an `ALLOW_OFFDOMAIN=true` flag.)
>
> **Formatting**
>
> - Concise answers.
> - Include effective dates if the page states them.
> - Output a final “Sources:” list with bullet links.

---

## 4) SDK outline (Node/TS)

```ts
// sdk/ask.ts (web-first, files as fallback)
import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function ask({
  message,
  topicHint, // e.g., "riverbend" or "melaleuca"
  vectorStoreIds = [], // optional for v1; can be empty
  model = process.env.OPENAI_MODEL || "gpt-4o-mini",
}: {
  message: string;
  topicHint?: "riverbend" | "melaleuca";
  vectorStoreIds?: string[];
  model?: string;
}) {
  const preferredDomains =
    topicHint === "riverbend"
      ? ["melaleuca.com/riverbendranch", "melaleuca.com"]
      : ["melaleuca.com", "melaleuca.com/riverbendranch"]; // ensure both, with priority order

  const systemText = `You are Melaleuca’s web-first agent. Use web_search first with these preferred domains: ${preferredDomains.join(", ")}. If web_search is inconclusive, then use file_search. Always cite sources. If neither yields enough evidence, tell the user to check the website at the best-matching canonical URL.`;

  const tools: any[] = [
    { type: "web_search" },
    ...(vectorStoreIds.length ? [{ type: "file_search", vector_store_ids: vectorStoreIds }] : []),
  ];

  const input = [
    { role: "system", content: [{ type: "text", text: systemText }] },
    { role: "user", content: [{ type: "text", text: message }] },
  ];

  // NOTE: The model will decide tool order; the system prompt strongly biases web-first.
  // You can also preface the user content with: `Prefer domain: ...` if your SDK supports it.

  const resp = await client.responses.create({ model, input, tools });

  // TODO: handle tool-call loop until final; extract citations (URLs or file IDs)
  // Return unified shape for the app layer
  // return { text: resp.output_text, citations: extractCitations(resp) };
}
```

**Notes**

- Keep tool list order as shown; the system prompt communicates priority.
- If your tool interface supports **domain allowlists**, pass `preferredDomains` as the `web_search` tool’s `domains`/`allow` parameter (when available). Otherwise, prepend `site:...` to the **first tool call** via the model instruction.

---

## 5) Website fallback rules

When both tools fail to produce a grounded answer:

- If the query is Riverbend‑related →: “I couldn’t confirm from our site or files. Please check: \*\*[https://www.melaleuca.com/riverbendranch\*\*.”](https://www.melaleuca.com/riverbendranch**.”)
- Else (default Melaleuca) →: “I couldn’t confirm from our site or files. Please check: \*\*[https://www.melaleuca.com/\*\*.”](https://www.melaleuca.com/**.”)

Optionally, include the **most likely** subpath if the query mentions a product or program (e.g., `/about`, `/products`), but do not fabricate a URL.

---

## 6) Adding files later (PDF → preferred formats)

- **Preferred**: Convert PDFs to **Markdown (.md)** with **YAML frontmatter**. This yields cleaner chunks and better citations.
- **Alternative**: Keep PDFs and attach a ``** sidecar** for metadata. The vector store will still extract text, but quality varies.

**Frontmatter (for .md):**

```yaml
---
canonical_id: LEG-privacy-2025-09-01
title: Global Privacy Policy
doc_type: policy
region: [US, MX, CA]
language: en-US
audience: internal
confidentiality: internal
effective_date: 2025-09-01
expires_at: null
version: 1.0
source_url: https://intranet/policies/privacy
---
```

**Sidecar (for PDFs):** `<file>.meta.json`

```json
{
  "canonical_id": "PRD-catalog-2025-03",
  "title": "Product Catalog – Spring 2025",
  "doc_type": "spec",
  "region": ["US", "CA"],
  "language": "en-US",
  "audience": "external",
  "confidentiality": "public",
  "effective_date": "2025-03-01",
  "expires_at": null,
  "version": "2025.1",
  "source_url": "https://intranet/product/catalogs/2025-spring.pdf"
}
```

**Upload path:** Use OpenAI vector stores with these metadata fields mirrored. Continue using the prior `normalize → validate → upload` pipeline; you just won’t rely on it for v1 answering.

---

## 7) Evaluation (web‑first)

Create `eval/golden_qa.jsonl` with on‑site fact questions that **must** cite melaleuca.com URLs:

```json
{"q":"What is Riverbend Ranch Beef?","hint":"riverbend","must_domain":"melaleuca.com/riverbendranch"}
{"q":"How do I become a Melaleuca customer?","must_domain":"melaleuca.com"}
```

In `run_eval.ts`, call `ask()` and assert that at least one citation starts with the `must_domain`.

---

## 8) Governance & safety

- **No off‑domain authority** unless first‑party sites lack coverage.
- **Always show sources (URLs)** and the page’s stated effective date if present.
- If a page looks promotional without details, prefer policy/FAQ/support pages.

---

## 9) Configuration

`.env` keys:

```
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini   # change to gpt-4o or gpt-5 when desired
PRIMARY_DOMAIN=melaleuca.com
RIVERBEND_DOMAIN=melaleuca.com/riverbendranch
WEB_CACHE_TTL_SECONDS=86400
```

---

## 10) Quickstart

1. Wire the SDK `ask()` with tools `[web_search, file_search]` but start with **no files uploaded**.
2. Test with Riverbend and Melaleuca questions; confirm URLs are always cited.
3. Later, add PDFs → convert to MD or attach `.meta.json` sidecars → upload to vector store → enable the file\_search fallback.

---

### Appendix A — Minimal tool‑call loop (pseudocode)

```ts
let response = await client.responses.create({ model, input, tools });
while (response.output[0]?.type === "tool_call") {
  // Inspect tool name → execute → append result → call again
  const tool = response.output[0];
  const toolResult = await runTool(tool);
  input.push({ role: "tool", content: [{ type: tool.name, ...toolResult }] });
  response = await client.responses.create({ model, input, tools });
}
return finalize(response);
```

```
```
