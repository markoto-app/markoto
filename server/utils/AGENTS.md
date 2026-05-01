# server/utils

Orchestration helpers + cross-cutting domain logic. Most files here are thin wrappers over `server/repos/`; the substantive ones (knowledge pipeline, AI loop, restore helper, history replay) get sub-sections below.

For the AI agentic loop in `agentic/` see its own AGENTS.md.

## Helpers worth knowing about

Format below: **what / when to use it / what NOT to do.**

### History, restore, diff
- `historyReplay.ts` — replays `yjs_documents` rows up to a target id to reconstruct a past Y.Doc. Powers `/diff` AND the `restoreDoc` helper. Don't try to compute a textual diff against the LATEST y-postgresql row — replay TO the boundary id captured on the activity row.
- `textDiff.ts` — wraps the `diff` library's `structuredPatch` for the diff endpoint. 200-hunk truncation guard. Don't drop the cap — pathological diffs can render the entire diff drawer unusable.
- `commentsSnapshotDiff.ts` — resolves a comment thread's state at a specific activity id (used by `/comment-context`).
- `restoreDoc.ts` — four-step Tier 2 helper (advisory-locked txn + replay + synthetic Hocuspocus client + capture-then-construct ordering). See `app/components/collab/AGENTS.md` for the UI side. Don't bypass the advisory lock — concurrent restores against the same doc race horribly.

### Access + identity
- `documentAccess.ts` — `requireDocEditAccess` / `requireDocViewAccess` / `decideActivityAccess`.
- `workspaceAccess.ts` — workspace-membership helpers (see `server/AGENTS.md`).
- `validatedSession.ts` — sealed-cookie + DB-validated session. Drives `requireValidatedUserSession` everywhere.
- `docTokenVerify.ts` — verifies the doc-scoped JWTs minted by `/api/docs/:id/token` for endpoints that don't have a Nitro session (rare, but used by some public/whitelisted activity endpoints).
- `renderTokens.ts` — mints + verifies the 60s `scope: 'render'` JWT used by the renderer sidecar to fetch `_internal/render-bootstrap`. Don't reuse `JWT_SECRET`-signed tokens of other shapes — `verifyRenderToken` rejects anything missing `scope === 'render'`.

### Rate limits & singleflights
- `rateLimit.ts` — Valkey-backed counters. `checkRateLimit` (request count), `consumeRateLimitBudget` (signed counter for ms / bytes / etc.), `tryAcquireSessionLock` / `releaseSessionLock` (concurrent-session caps). **Polarity is intentional:** `checkRateLimit` / `consumeRateLimitBudget` fail OPEN on Valkey error (DoS protection, not a cost cap — better to serve than to brick); `tryAcquireSessionLock` fails CLOSED (correctness — failing open would double-bill GCP). Don't accidentally flip either.
- `idempotency.ts` — `withIdempotency(event, scope, userId, fn)`. Stripe-style request dedup keyed on the `Idempotency-Key` header scoped to `(scope, userId, key)` — same UUID from two users doesn't collide. First request claims a Valkey `SET NX EX` placeholder; on success the result is cached for 5 min; on failure the placeholder is deleted so retries can re-attempt. Concurrent retry while a request is still in flight returns 409 with a Retry-After hint (fail-fast over poll-and-wait). Used by `POST /api/docs/:id/duplicate`. Don't use for billing-correctness paths — those live at the DB level via the Stripe `processed_webhook_events` table + atomic counter UPSERT.
- `sweepLock.ts` — `acquireSweepLock(name)` / `releaseSweepLock(name)`. Coarse cross-instance lock for periodic sweepers. Postgres advisory locks **session-scoped**, NOT transaction-scoped — sweep work spans many transactions (or none), so `pg_try_advisory_xact_lock` would auto-release the moment the acquire query commits, defeating the purpose. To keep the lock alive across the whole sweep, `acquire` checks out a `PoolClient`, runs `pg_try_advisory_lock(hashtext(name))` on it, and **pins** the same client in a per-process Map so `release` reuses it. Adding a new sweeper plugin? **It MUST acquire the lock before doing work; a `finally`-released lock by `name`.** All current sweepers do this (`orphan-cleanup`, `ai-session-sweep`, `inactive-doc-sweep`, `knowledge-sweep`, `webhook-event-sweep`, `plan-lapse-sweep`).

### Outbound HTTP plumbing
- `traceHeaders.ts` — `injectTraceHeaders(headers)` adds `sentry-trace` + `baggage` from the active span so a Sentry transaction continues across the renderer / sync / markitdown call. Returns headers unchanged when there's no active span (e.g. a sweeper firing outside an HTTP request) or when the SDK errors — failed propagation never propagates into the caller. Threading sites: `renderClient.ts` → renderer; `processKnowledge.ts` → markitdown (downstream ignores today, but the outbound span is still emitted); `syncNotify.ts` + `documentLifecycle.ts` → sync-server `/internal/*`.
- `renderClient.ts` — Nuxt-side counterpart to the renderer sidecar. `renderDocument(docId, {format})` returns `{cached, manifest}`:
  1. Compute the doc's current `snapshotId` (latest `yjs_documents.id`).
  2. HEAD `s3://renders/{docId}/{snapshotId}/manifest.json` — cache hit short-circuits.
  3. Two-tier singleflight: an in-process Map (`docId:snapshot:format`) dedups same-instance callers; a Valkey lock dedups cross-instance. Loser path polls for the winner's manifest at 750 ms cadence until lock TTL (90 s render + 30 s buffer); on poll timeout the loser attempts its own render (better one extra render than an opaque timeout).
  4. Calls the renderer container with `INTERNAL_API_SECRET` auth. Renderer materialises the doc via the internal print page → paged.js → PDF + per-page PNGs → S3 manifest LAST as the readiness sentinel.
  - **Failure mode:** the PDF endpoint surfaces a real error to the user — there is NO automatic fallback to client-side paged.js. Client-side print is still wired into the editor's `Cmd+P` hijack but is not used as a server-side fallback.
  - **Cleanup:** `cleanupRendersForDoc(docId)` is called by `documentLifecycle.deleteDocument` so deleted docs don't leave stale renders in S3.
- `healthProbes.ts` — per-component liveness for `/api/health` + `/api/health/deep`. Probes `postgres` + `valkey` + `sync` + `renderer` + `markitdown` in parallel via `Promise.allSettled`, each bounded at a 1s timeout. Postgres / Valkey / sync are required (URLs hard-fail at boot via `${VAR:?required}`). Renderer / markitdown URLs are optional — unconfigured returns `'skipped'`, NOT `'down'`, so a self-hosted opt-out doesn't flag the instance degraded. The `/api/health` aggregator caches healthy results for 5s and degraded results for 2s; `/api/health/deep` skips the cache (auth-gated, low-frequency).

### Billing
- `billing.ts` — single source of truth for the Model C anchor logic. Exports `resolveBillingContext(userId, workspaceId)` returning `{plan, attributedTo, periodStart, periodEnd, interactionsRemaining, attribution}`. The `(+)` workspace mechanic at the code level: when a workspace has `aiEnabled=true` AND `billingOwnerId` set AND that owner is on `max`/`ultra` AND not lapsed, ANY member's AI calls bill against `workspace:{wsId}` instead of `user:{userId}`. Lapsed / downgraded owners collapse back to self-bill — the resolver re-checks the owner's `(plan, planValidUntil, stripeCurrentPeriodStart)` on every call so a Stripe state change is reflected immediately, with `planLapseSweep.ts` as a belt-and-braces correction of the workspace row state. Period anchoring: paid-and-active users use Stripe's `current_period_start` / `current_period_end`; everyone else uses calendar-month UTC. `chargeInteractions(args)` is the atomic `INSERT ... ON CONFLICT DO UPDATE SET interactions_used = interactions_used + EXCLUDED.interactions_used` against `ai_usage_period` — the returned `interactions_used` is compared to the cap and the txn rolls back with `BudgetExhausted` if it overshoots. Don't read-modify-write; let the UPSERT race-correct.
- `planLapseSweep.ts` — runs in `server/plugins/plan-lapse-sweep.ts`. Disables `(+)` on workspaces whose billing owner deleted their account (FK `ON DELETE SET NULL` nulled `billing_owner_id` but `ai_enabled` stayed true), lapsed (`planValidUntil < now()`), or downgraded below max/ultra. Sets `aiEnabled=false` AND `billingOwnerId=null`. Belt-and-braces — the resolver already self-bills these users at runtime; the sweeper exists so the admin UI's `(+)` badge reflects DB truth.
- `stripeClient.ts` — singleton Stripe SDK client. Lazy-initialised; reads the secret key from runtime config.
- `stripeWebhook.ts` — pure dispatcher (separated from the HTTP endpoint so unit tests can call handlers without going through signature verification per case). `dispatchStripeEvent(event, opts)` runs everything in ONE transaction:
  1. **Replay protection** — INSERT into `processed_webhook_events` with `ON CONFLICT DO NOTHING`. If the returning array is empty, the event was already processed; short-circuit with `{handled: true, replayed: true}`. Stripe gets a 200 and stops retrying, but no UPDATEs re-apply (preserves manual ops corrections).
  2. **Out-of-order stash** — for `subscription.*` and `invoice.*` events, probe whether any user owns this `customerId`. If not, stash the full payload in `pending_stripe_events` and bail with `{handled: true, stashed: true}`.
  3. **Dispatch** to the matching handler (`handleCheckoutSessionCompleted`, `handleSubscriptionUpdated`, `handleSubscriptionDeleted`, `handleInvoicePaid`, `handleInvoicePaymentFailed`).
  4. **Drain** — if the event was `checkout.session.completed`, replay any stashed events for this customer in `received_at` order, marking each `processed=true`.

  **Why the stash is needed when `customer.subscription.created` arrives before `checkout.session.completed`:** Stripe fires both events on a successful checkout, and delivery order is NOT guaranteed. Today the stash is masked because `handleCheckoutSessionCompleted` runs a synchronous `stripe.subscriptions.retrieve` and applies canonical state from the live API. If anyone removes that fetch for perf, dropped subscription events become a real bug — the stash is the safety net.

  **Don't add a handler that throws on unknown customer.** Use the stash path; the sweeper retains unprocessed rows for 30 days so Ops can reconcile.
- `webhookEventSweep.ts` — runs in `server/plugins/webhook-event-sweep.ts`. Prunes `processed_webhook_events` (>90d — Stripe replays only ~3d, but the long retention serves forensic queries) and `pending_stripe_events` (processed ≥7d audit window or unprocessed ≥30d).

### Other helpers
- `templateRenderer.ts` — server-only template body renderer, fs.readFileSync of `shared/templates/content/<id>/<locale>.md`. See `shared/templates/AGENTS.md`.
- `fileTypeGuard.ts` — magic-byte sniff via `file-type` for upload validation.
- `throttledSentry.ts` — caps Sentry capture frequency for repetitive events (Valkey reconnect loops, sync notify retries) so a degraded dependency doesn't blow our event budget.

---

## Workspace Knowledge Base

Workspace-scoped file uploads that the AI can retrieve from. Lives under `/w/:id` (and embedded in the editor's right sidebar via the library icon next to Activity + Theme). Files flow: presigned S3 PUT → markitdown parse → heading-aware chunker → Gemini per-chunk embedding → pgvector row. Retrieval: hybrid RRF over vector + BM25.

### Data

- **`workspace_knowledge`** — one row per uploaded file. Statuses: `processing` → `ready` / `failed`. Columns of note: `markdown_cache` (parsed output, served to `get_knowledge_file`), `embedding_version` (`model:dims`, so future model bumps can detect stale rows), `chunk_count`/`token_count` (audit + surfacing), `s3_key` (original file, deleted after successful processing).
- **`workspace_knowledge_chunks`** — per-chunk. `embedding vector(768)` + HNSW cosine index + STORED generated `content_tsv tsvector` + GIN index. `workspace_id` is denormalised so the search query doesn't need the parent-table join.

### Upload pipeline

Two-phase presign (same pattern as image uploads):

1. `POST /api/workspaces/:wsId/knowledge/upload-request` — `requireKnowledgeEditAccess` (admin/editor) + rate-limit (30/min/user) + `reserveUploadSlot` (checks per-workspace + per-user caps, reserves Valkey inflight slots) → mints a 300s `ContentType`-bound presigned PUT URL. No DB row yet.
2. Client PUTs bytes directly to S3.
3. `POST /api/workspaces/:wsId/knowledge/confirm` — HEADs the object, magic-byte sniff via `file-type`, advisory lock (`pg_advisory_xact_lock(hashtext(wsId))`) + cap recheck + filename disambiguation + row insert in ONE transaction, releases inflight slots in `finally`, then `void processKnowledge(id)` fire-and-forget.

### `processKnowledge.ts`

Sequential: fetch S3 bytes → POST to markitdown (`markitdown-server` FastAPI at `$NUXT_MARKITDOWN_URL`) with `?ext=…` → chunk the returned markdown (heading + paragraph aware, `maxChunks` cap from config — sentinel truncation chunk on overflow) → embed each chunk with `RETRIEVAL_DOCUMENT` task-type → `DELETE FROM chunks WHERE knowledge_id = :id` then bulk `INSERT` new chunks → flip status to `ready` + populate `markdown_cache` → delete the original S3 object. Errors flip the row to `failed` with a truncated `error_message`. Row-existence re-checked after conversion AND after embedding so a user deletion mid-pipeline aborts cleanly without wasting embedding round-trips.

### `embeddings.ts`

Gemini's JS SDK `embedContent` with `contents: [str, str, …]` returns ONE aggregate embedding for the combined content — NOT one per string like the Python SDK. We loop per-chunk with a bounded `CONCURRENCY = 5` pool. Model + dims live in `config.google.embeddingModel` / `embeddingDims`; `embeddingVersionTag` (`model:dims`) is persisted with every row for future re-embed detection. `RETRIEVAL_DOCUMENT` task-type on ingest, `RETRIEVAL_QUERY` on search — Gemini's hints measurably improve recall.

### Hybrid search (`server/repos/knowledge.ts`)

Two queries fire in parallel (`candidatePool = 4 × topK` each):

- Vector: `1 - cosineDistance(embedding, :q)` via pgvector, `ORDER BY similarity DESC`.
- Lexical: `ts_rank_cd(content_tsv, websearch_to_tsquery('english', :qtext))` with `@@` predicate, `ORDER BY score DESC`.

Results merged by `(knowledgeId, chunkIndex)` and ranked via **Reciprocal Rank Fusion** (`sum over sources of 1/(60 + rank)`). Chunks in both sources get a double contribution; chunks in one still place reasonably. Output carries both scores. `websearch_to_tsquery` is forgiving — empty tsquery on all-stopwords returns zero lexical rows and the fusion quietly degrades to vector-only.

### Abuse limits

| Layer | Check | Where |
|---|---|---|
| Rate limit | 30 upload-requests / user / min | `checkRateLimit('knowledge-upload', …)` in upload-request |
| Per-workspace caps | 500 files + 1 GB | DB count/sum at upload-request + confirm |
| Per-user caps | 100 files + 2 GB across ALL workspaces | DB count/sum at upload-request + confirm |
| Workspace-per-user cap | 20 owned workspaces | `countOwnedWorkspacesByUser` in `POST /api/workspaces` |
| Concurrent races | Valkey inflight counters (`knowledge-upload-ws` + `knowledge-upload-user`), 6 min TTL | `reserveInflightSlot` / `releaseInflightSlot` (fail CLOSED) |
| Confirm race | Postgres advisory lock `pg_advisory_xact_lock(hashtext(wsId))` inside a txn | confirm endpoint |
| Content-type bypass | Magic-byte sniff via `file-type` on first 4 KB of S3 object | `fileTypeGuard.ts`, called in confirm |
| Chunk-count abuse | `maxChunksPerFile = 300` sentinel-truncation | `chunkMarkdown` in `processKnowledge` |
| Abandoned `failed` rows | TTL sweep: `status='failed'` rows older than `failedRetentionDays = 7` auto-reaped | `server/plugins/knowledge-sweep.ts` |
| Stuck `processing` rows | TTL sweep: `status='processing'` rows older than 10 min re-process | same plugin |

All caps live in `config.knowledge.*`; workspaces-per-user in `config.workspaces.maxPerUser`. The inflight counter fails CLOSED (correctness cap); the rate limit fails OPEN (DoS protection, not a cost cap). The advisory lock is load-bearing: without it, two concurrent confirms that both read N-1 used at upload-request time would both commit and land at N+1.

### Content-type validation

`file-type` sniffs the first 4 KB fetched via S3 Range GET (`bytes=0-4095` — enough for the package's internal readers, including ZIP-inside-ZIP inspection for Office formats). Allowlist per ext: PDF → `application/pdf`; DOCX/PPTX/XLSX → the specific Office MIME; XLS → `application/vnd.ms-excel` OR `application/x-cfb`. Text formats (MD/TXT/HTML/HTM) have no reliable magic — we instead decode as strict UTF-8 and check ≥90% printable chars on the first 1 KB. Mismatch → 415 + orphan S3 delete + slot release.

### AI integration

The two knowledge tools (`search_knowledge`, `get_knowledge_file`) are in `KNOWLEDGE_TOOL_DECLARATIONS`, separate from `ALL_TOOL_DECLARATIONS`, and are ONLY passed to `runAgenticLoop` when both: (a) session has `workspaceId` AND (b) workspace has ≥1 ready file. The system prompt also appends a `<knowledge_files>` block listing `{knowledge_id, filename, sizeBytes, ext, tokenCount}` — fabricated knowledge_ids are explicitly rejected. `AiSession.workspaceId` flows from `/api/ai/prompt` resolution → `createAiSession` → tool handlers, which double-check scope as defense in depth.

### UI

`WorkspaceKnowledgePanel.vue` drives upload + list + delete with XHR progress tracking and 5s-interval status polling. Mounted in two places: the workspace overview (`app/pages/w/[id].vue`) with the full header, and the editor's right sidebar (`EditorLayout.vue`) with `compact` prop. Delete uses `WorkspaceKnowledgeDeleteConfirmModal.vue`.

## Knowledge gotchas

- **Gemini JS SDK `embedContent([str, str, …])` returns ONE vector, not N** — the SDK treats the array as a multi-part Content. Loop per-chunk with bounded concurrency. Python SDK does per-string; don't port Python patterns blindly. Symptom: `[embeddings] expected N vectors, got 1` flipping the row to `failed`.
- **pgvector HNSW caps at 2000 dims** — 3072-d (Gemini's full `gemini-embedding-2-preview`) can't use HNSW; must use IVFFlat or drop to 768/1536 via MRL. We pick 768 for HNSW compat + cost.
- **`websearch_to_tsquery` on stopword-only input returns empty tsquery** — the `@@` predicate then returns zero rows. Hybrid search degrades to vector-only in that case rather than erroring; don't add a guard that short-circuits on empty queries or you lose useful signal on single-keyword searches.
- **Advisory locks must be INSIDE a txn** — `pg_advisory_xact_lock(hashtext(...))` only releases on COMMIT/ROLLBACK. All knowledge-confirm writes go through `db.transaction(async tx => ...)`.
- **Valkey inflight counter fails CLOSED** — if Valkey is down, `reserveInflightSlot` returns `allowed: false`. We'd rather reject uploads on Valkey outage than let uncapped concurrent uploads through.
- **`file-type` returns undefined on plain-text input** — no magic bytes for MD/TXT/HTML. The guard falls through to a printable-UTF-8 ratio check on the first 1 KB. Don't treat `undefined` as "unknown format = allow"; that's an allowlist bypass.
- **Knowledge S3 original is deleted after processing** — `deleteKnowledgeArtifact` still tries to delete on row-delete, tolerating 404. Don't assume `workspace_knowledge.s3_key` points at a live object for `ready` rows.
- **`processKnowledge` re-checks row existence after conversion AND after embedding** — user can delete mid-pipeline; without the re-check we'd waste Gemini embedding calls on a doomed insert.
- **`pgvector/pgvector:pg16` over stock `postgres:16-alpine`** — data-dir-compatible drop-in. Migration `0005` hand-prepends `CREATE EXTENSION IF NOT EXISTS vector` because drizzle doesn't emit extension DDL.
- **Confirm-endpoint input binding:** the knowledge-confirm handler requires `knowledgeId` to match the last path segment of `s3Key` — closes the "mint a presign for key A but claim it under knowledgeId B" surface.
- **Mid-session workspace membership drift:** `/api/ai/prompt` resolves `session.workspaceId` once at session open. Knowledge tool handlers re-check `getMemberRole(workspaceId, initiatorUserId)` on every invocation via `verifyWorkspaceMembership()` so an admin demotion mid-session immediately revokes further knowledge access at the next tool call.
