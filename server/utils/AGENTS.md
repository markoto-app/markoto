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
- `healthProbes.ts` — per-component liveness for `/api/health` + `/api/status` + `/api/health/deep`. Probes `postgres` + `valkey` + `sync` + `s3` (HeadBucket) + `renderer` + `markitdown` + `litellm` in parallel via `Promise.allSettled`, each bounded at a 1s timeout. Postgres / Valkey / sync are required (URLs hard-fail at boot via `${VAR:?required}`). Renderer / markitdown / litellm / s3 skip cleanly when unconfigured (`'skipped'`, not `'down'`). **`isOverallHealthy` (the 200/503 Traefik gate) EXCLUDES S3** — object storage backs uploads/backups, not the core doc path, so an S3 outage must not 503 a single-instance node out of rotation; it's still reported on the status board. The three endpoints share ONE TTL'd fan-out via `getCacheEntry` (`getCachedHealth` → minimal 200/503 body; `getCachedProbeResults` → full per-component for `/api/status`; `/api/health/deep` runs uncached, auth-gated). Healthy cached 5s, degraded 2s.

### AI providers — bring your own key (`aiProviders/`)
- `config.ts` — env readers (process.env per call): `readInstanceDefault(capability)` (`NUXT_AI_DEFAULT_*`), `resolveByokUrlPolicy()` (`NUXT_AI_BYOK_ALLOWED_BASE_URLS`, `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS`), `OPERATOR_URL_POLICY`, `instanceDefaultProblems()` (logged at boot by `plugins/ai-provider-defaults-check.ts`).
- `urlPolicy.ts` — `checkProviderBaseUrl(url, policy, resolver)`: the SSRF gate (pure + injectable DNS). Order: structure → internal hostnames → allowlist → DNS (always-forbidden: loopback / link-local / metadata / multicast via `urlGuard.isAlwaysForbiddenIp`; private only with opt-in) → http only to private. Don't bypass it for "trusted" URLs — operator defaults use `OPERATOR_URL_POLICY`, not no policy.
- `resolve.ts` — `resolveAiProviders(userId)` (own → instance → null), `availabilityFrom()`, `liveDictationTarget()`, `litellmModelFor()`.
- `requestFields.ts` — `providerRequestFields()` (request-time policy re-check), `withProviderErrors()` + `redactSecret()` + `classifyProviderError()`.
- `verify.ts` — save-time probe through LiteLLM (chat: tool call at temperature 0; transcription: silent WAV; image: `GET /models`, never a paid generation).
- `store.ts` — the ONLY place that encrypts a provider key; `toProviderView()` is the only shape that leaves the server (host + last four). A stored key is reused on update only while the base URL is unchanged.
- `guard.ts` — `requireAiProviders(userId, capability)` → 409 `ai/provider-missing` with `messageKey` + a `/settings/ai` recovery link.

### Web tools (`webTools.ts`)
- `getWebToolAvailability()` / `isWebToolAvailable(tool)` (upstream key present), `getWebToolLimits()` (`NUXT_WEB_TOOLS_{HOURLY,DAILY}_LIMIT`, read per call), `consumeWebToolQuota(userId)` → 429 `ai/web-tools-rate-limited`. One allowance for `web_search` + `fetch_url`, shared by the in-editor loop and MCP; fail OPEN. See `agentic/AGENTS.md`.

### Billing
- `billingMode.ts` — the `NUXT_BILLING_ENABLED` / `NUXT_PLANS_COMING_SOON` switch (parser in `shared/config/billingMode.ts`). `assertBillingEnabled()` → 404 `billing/disabled` on every billing-only route; `effectivePlan(plan, validUntil)` → `free` whenever billing is off (and for lapsed paid plans when on) — used by `billing.ts`, `knowledgeQuota.ts`, `POST /api/workspaces`; `limitRecovery()` / `limitUpgradeHint()` / `budgetExhaustedMessage()` / `budgetExhaustedBreadcrumb()` / `budgetExhaustedMessageKey()` pick "Upgrade" (billing on), "paid plans coming soon" (hosted free-only SaaS) or neither (self-hosted). Reads `process.env` per call so repos/unit tests can `vi.stubEnv` it. With billing off the Stripe customer step of account deletion and the Stripe section of the data export are skipped (empty placeholders), and the Stripe sweepers never start.
- `stripeStartupCheck.ts` — pure boot-time Stripe validation used by `plugins/01-validate-secrets.ts`; returns no errors with billing off, today's strict checks with billing on.
- `billing.ts` — single source of truth for the Model C anchor logic. Exports `resolveBillingContext(userId, workspaceId)` returning `{plan, attributedTo, periodStart, periodEnd, virtualKey, attribution}`. The `(+)` workspace mechanic at the code level: when a workspace has `aiEnabled=true` AND `billingOwnerId` set AND that owner is on `max`/`ultra` AND not lapsed, the resolver returns the SPONSOR's virtual key, so any AI call placed by the member spends from the sponsor's LiteLLM budget. Lapsed / downgraded owners collapse back to self-bill — the resolver re-checks the owner's `(plan, planValidUntil, stripeCurrentPeriodStart)` on every call so a Stripe state change is reflected immediately, with `planLapseSweep.ts` as a belt-and-braces correction of the workspace row state. Period anchoring: paid-and-active users use Stripe's `current_period_start` / `current_period_end`; everyone else uses calendar-month UTC. **Phase 6:** the app-side interaction counter (`ai_usage_period` table + `chargeInteractions` UPSERT + `BudgetExhausted` exception) is gone. LiteLLM's per-virtual-key `max_budget` is the only enforcement gate. Callers wrap their LLM call in `useLitellmForUser(virtualKey)` and catch `LitellmBudgetExhausted` (or detect via `isBudgetExceededError(...)`) to surface the upgrade-CTA breadcrumb. Stripe webhooks call `updateUserKeyBudget` / `resetUserKeySpend` on plan changes + monthly renewals (the periodic monthly reset itself is LiteLLM's `budget_duration: '30d'`; `reset_spend` needs a JSON body `{reset_to: 0}` on v1.106 or it 422s); both are no-ops in `TEST_MODE` so integration tests don't try to reach the proxy.
- `litellmKeys.ts` — per-user virtual-key CRUD. `ensureUserKey(userId, plan)` lazy-creates on first AI use and persists `keyId` + AES-256-GCM-encrypted `keyToken` to `users`. `getUserKeyToken` decrypts for inline use; never logged. `getUserKeyInfo` reads live spend + max_budget from `/key/info` for the AI Points UI. `TEST_MODE=1` short-circuits every external call to a stub key (`sk-fake-test-virtual-key`) so the integration suite can exercise the billing-context resolver path without a live proxy.
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

### Privacy / account lifecycle
- `accountDeletion.ts` — request/cancel orchestrators called from the user-delete endpoints. `requestAccountDeletion(userId, reason)` flips `deletion_requested_at`, audits `account.delete_requested`, and triggers the "deletion scheduled" email (via `safeSendTransactionalEmail`). `cancelAccountDeletion(userId)` nulls all three deletion columns and audits `account.delete_cancelled`. **Don't run the purge inline** — let the sweeper claim it.
- `accountDeletionPlan.ts` — pure `planAccountDeletion(userId)`. Returns `{ workspaceFates: [...] }` for the consequences modal: each owned workspace is `cascade-delete` (sole member), `promote-admin` (multi-member, names the longest-tenured other admin), or `remove-membership` (user isn't owner). Pure projection — no writes; safe to call from a GET endpoint.
- `accountDeletionExecute.ts` — the 10-step cascading purge. In order: delete Stripe customer (best-effort), delete owned doc S3 keys + render manifests, run `deleteDocument()` per owned doc, cascade-delete sole-member workspaces, promote longest-tenured admin on multi-member workspaces and remove user's membership, anonymise comments on others' docs (sets `author_user_id=NULL`, `author_name_snapshot='Deleted user'`), null FK on `audit_log.actor_user_id` / `consent_log.user_id` / `activity_log.user_id` (set-null, NOT delete — see `server/db/AGENTS.md`), delete the user row. Audit `account.delete_executed` LAST. Don't reorder — the FK set-nulls assume the user row still exists.
- `accountDeletionSweep.ts` — runs in `server/plugins/account-deletion-sweep.ts`. Acquires sweep lock, claims users with `deletion_requested_at < now() - $GRACE_PERIOD` (default 30 days), runs `accountDeletionExecute` per row. Failures skip + retry next cycle.
- `dataExport.ts` — pure `buildExportZip(userId)` returns the in-memory bytes of a 13-entry ZIP via `fflate`. Entries: `profile.json`, `workspaces.json`, `documents/<docId>/{meta.json, content.md, history/}` (Y.js reconstructed via `historyReplay`), `comments.json`, `activity-log.json`, `audit-log.json` (filtered to user-as-actor), `knowledge-metadata.json`, `consent-log.json`, `billing-snapshot.json`, plus `README.md` describing each entry. **`yjs_documents` table doesn't always exist** in test envs (created lazily by sync-server) — the builder probes `pg_class` and skips Y.js reconstruction on miss rather than 42P01-ing.
- `dataExportWorker.ts` — runs in `server/plugins/data-export-worker.ts`. Polls `data_export_jobs.claimQueuedJob()` (atomic UPDATE … RETURNING that flips `queued` → `processing`), builds the ZIP, uploads to S3 (`exports/{userId}/{jobId}.zip`), writes `s3_key` + 7-day `expires_at`, audits `account.export_completed`, fires the "export ready" email. Errors → `markJobFailed` + audit `account.export_failed`.
- `dataExportExpirySweep.ts` — flips `ready` rows past `expires_at` to `expired` and best-effort deletes the S3 object. Runs from `server/plugins/data-export-expiry-sweep.ts`.
- `email/sendEmail.ts` — Resend SDK with sandbox-sender fallback (`markoto <onboarding@resend.dev>`) auto-detected when no verified domain is configured. `NUXT_EMAIL_PROVIDER=stub` opts out entirely (test mode). Exports `sendTransactionalEmail` (throws on failure) AND `safeSendTransactionalEmail` (swallows + Sentry-captures — use this in fire-and-forget contexts where the primary state has already committed). Kinds: `account.deletion.requested`, `account.deletion.executed`, `data.export.ready`, `breach.notification` (re-used for abuse-report operator notifications), `waitlist.confirm` (double-opt-in email; sent with `bodyContainsSecrets: true` so stub mode never logs the single-use links).
- `waitlist.ts` + `waitlistSweep.ts` — paid-plans waitlist helpers: `isWaitlistOpen()` (billing off AND plans coming soon), email/locale normalisation, 256-bit token mint + SHA-256 hash, the localised (6-locale) plain-text confirm email, and the hourly sweep of unconfirmed rows past the 7-day window. Repo: `server/repos/waitlist.ts`. The user's linked rows appear in the data export as `waitlist.ndjson` (no token hashes) and go away with the account (FK cascade).
- `adminAccess.ts` — `isAdminUser(userId)` (column-first via `users.is_admin`, falls through to env-list), `isAdminEmail(email)` (env-list parser — case-insensitive on BOTH sides, comma-separated, whitespace + empty-segment tolerant; reads env on every call, no module-scope cache), `requireAdminUser(event)` (throws 403 unless admin). Pinned by `tests/unit/adminAccess.test.ts`.
- `adminBootstrap.ts` — `bootstrapAdminFromEnv(userId, email)` called from every OAuth callback. If the email is in `NUXT_ADMIN_USER_EMAILS` and `users.is_admin` is false, flips it true + audits `admin.granted`. Lets a fresh deploy + a listed email = instant admin without manual `UPDATE`.

### Other helpers
- `error.ts` (in `server/`, not `utils/`) — Nitro `errorHandler`. Exports `buildSanitizedErrorPayload(error, url)` (pure, exported for `tests/unit/errorSanitizer.test.ts`). 4xx pass through (preserve `message` + `data`); 5xx strip to generic + `code: 'internal'`. Stack traces never appear. Wired via `nitro.errorHandler: '~~/server/error.ts'` in `nuxt.config.ts`.
- `templateRenderer.ts` — server-only template body renderer, fs.readFileSync of `shared/templates/content/<id>/<locale>.md`. See `shared/templates/AGENTS.md`.
- `fileTypeGuard.ts` — magic-byte sniff via `file-type` for upload validation.
- `throttledSentry.ts` — caps Sentry capture frequency for repetitive events (Valkey reconnect loops, sync notify retries) so a degraded dependency doesn't blow our event budget.

---

## Workspace Knowledge Base

Workspace-scoped file uploads that the AI can retrieve from. Lives under `/w/:id` (and embedded in the editor's right sidebar via the library icon next to Activity + Theme). Files flow: presigned S3 PUT → markitdown parse → heading-aware chunker → Jina per-chunk embedding (via LiteLLM) → pgvector row. Retrieval: hybrid RRF over vector + BM25.

### Data

- **`workspace_knowledge`** — one row per uploaded file. Statuses: `processing` → `ready` / `failed`. Columns of note: `markdown_cache` (parsed output, served to `get_knowledge_file`), `embedding_version` (`model:dims`, so future model bumps can detect stale rows), `chunk_count`/`token_count` (audit + surfacing), `s3_key` (original file, deleted after successful processing).
- **`workspace_knowledge_chunks`** — per-chunk. `embedding vector(768)` + HNSW cosine index + STORED generated `content_tsv tsvector` + GIN index. `workspace_id` is denormalised so the search query doesn't need the parent-table join.

### Upload pipeline

Two-phase presign (same pattern as image uploads):

1. `POST /api/workspaces/:wsId/knowledge/upload-request` — `requireKnowledgeEditAccess` (admin/editor) + rate-limit (30/min/user) + `reserveUploadSlot` (checks per-workspace + per-user caps, reserves Valkey inflight slots) → mints a 300s `ContentType`-bound presigned PUT URL. No DB row yet.
2. Client PUTs bytes directly to S3.
3. `POST /api/workspaces/:wsId/knowledge/confirm` — HEADs the object, magic-byte sniff via `file-type`, advisory lock (`pg_advisory_xact_lock(hashtext(wsId))`) + cap recheck + filename disambiguation + row insert in ONE transaction, releases inflight slots in `finally`, then `void processKnowledge(id)` fire-and-forget.

### `processKnowledge.ts`

Sequential: fetch S3 bytes → POST to markitdown (`markitdown-server` FastAPI at `$NUXT_MARKITDOWN_URL`) with `?ext=…` → chunk the returned markdown (heading + paragraph aware, `maxChunks` cap from config — sentinel truncation chunk on overflow) → embed each chunk with the `retrieval.passage` task → `DELETE FROM chunks WHERE knowledge_id = :id` then bulk `INSERT` new chunks → flip status to `ready` + populate `markdown_cache` → delete the original S3 object. Errors flip the row to `failed` with a truncated `error_message`. Row-existence re-checked after conversion AND after embedding so a user deletion mid-pipeline aborts cleanly without wasting embedding round-trips.

### `embeddings.ts`

**Always via LiteLLM; default Jina, operator-configurable for self-hosters.** Hosted markoto uses `jina-embeddings-v5-text-nano` (768-d) and exposes no user override. A self-hoster sets `NUXT_LITELLM_EMBEDDINGS_MODEL=custom-embeddings` + `NUXT_LITELLM_EMBEDDINGS_DIMS` and the proxy-side `EMBEDDINGS_UPSTREAM_{MODEL,API_BASE,API_KEY}` (the `custom-embeddings` entry in `infra/litellm/config.yaml` resolves them through `os.environ/…`). Operator-level config only: no per-request/clientside credentials (that is the user-BYOK mechanism for chat). Full operator docs: `docs/AI-MODELS.md#embeddings`.

Public API is provider-agnostic: `embedDocuments` / `embedQuery` / `embeddingVersionTag` / `resolveEmbeddingsConfig` / `buildEmbeddingsConfig`; callsites in `processKnowledge.ts`, `repos/knowledge.ts`, and `scripts/reembed-knowledge.ts` don't know the backend. Bounded `CONCURRENCY = 5` pool; one `/v1/embeddings` call per chunk.

**Request parameters** are decided by the pure helpers in `shared/utils/embeddingConfig.ts`: Jina's `task` hint (`retrieval.passage` on ingest, `retrieval.query` on search; top-level body field, NOT `extra_body`; vectors differ by task) and the OpenAI `dimensions` field are sent for Jina models by default and are opt-in (`NUXT_LITELLM_EMBEDDINGS_{TASK_HINTS,SEND_DIMENSIONS}` = `auto|true|false`) for everything else — LiteLLM answers 400 to `dimensions` on OpenAI-compatible models other than `text-embedding-3-*`. The vector-length check in `embedOne` stays: it is what catches a wrong `NUXT_LITELLM_EMBEDDINGS_DIMS`.

`embeddingVersionTag` is `{provider}/{model}:{dims}` (`jina/jina-embeddings-v5-text-nano:768`; custom: `custom/<EMBEDDINGS_UPSTREAM_MODEL>:<dims>`, the app gets the label via `NUXT_LITELLM_EMBEDDINGS_UPSTREAM_MODEL`, mapped from `EMBEDDINGS_UPSTREAM_MODEL` by compose). It is persisted on `workspace_knowledge.embedding_version`; rows with another tag are stale for the re-embed command.

**Column dimension** (`embeddingColumn.ts`, `knowledgeEmbeddingsStatus.ts`, `plugins/02-embeddings-dimension.ts`): the column is `vector(768)` in schema/migrations. After migrations the plugin compares `format_type` of the column with `NUXT_LITELLM_EMBEDDINGS_DIMS` under the session advisory lock `knowledge-embedding-dimension` (waits up to 60 s): equal → no-op; no stored (non-NULL) vectors → drop HNSW index, `ALTER … TYPE vector(N) USING NULL`, recreate index, one transaction with the table locked; stored vectors of another size → refuse. Refusal/invalid config **degrades knowledge only**: `assertKnowledgeEmbeddingsReady()` (10 s cached catalog read, so it self-heals after a re-embed with no restart) fails `processKnowledge` rows and `search_knowledge` with the actionable message, and `/api/health/deep` shows `checks.embeddings` — deliberately NOT part of `isOverallHealthy`, so a bad embeddings setup never 503s the instance out of rotation. Max 2000 dims (`MAX_EMBEDDING_DIMS`, HNSW limit on `vector`; `halfvec` would allow 4000 but needs a different column type and query operators — not supported).

**Re-embed command** (`bun run knowledge:reembed` → `scripts/reembed-knowledge.ts` → `reembedKnowledge.ts#runReembed`, injectable embedder for tests): takes the same advisory lock (single attempt, so a concurrent boot waits/degrades rather than racing), drops the index + retypes the column if the dimension changed (marks every ready file `pending-reembed`), re-embeds file by file (embed all chunks, then write vectors + version tag in one transaction → resumable: rerun does only the still-stale files), recreates the index at the end. `--dry-run`, `--force` (once; resets progress), `--batch-size`, `--concurrency`, `--pause-ms`. Knowledge search is degraded while it runs.

**Reranker intentionally NOT in the pipeline.** Hybrid vector + BM25 RRF is sufficient for writing-doc retrieval. A reranker stage would add 100-200ms latency + extra Jina-token cost per knowledge search without a justified quality win on this workload. Revisit only if recall becomes the bottleneck under real usage.

### Hybrid search (`server/repos/knowledge.ts`)

Two queries fire in parallel (`candidatePool = 4 × topK` each):

- Vector: `1 - cosineDistance(embedding, :q)` via pgvector, `ORDER BY similarity DESC`.
- Lexical: `ts_rank_cd(content_tsv, websearch_to_tsquery('english', :qtext))` with `@@` predicate, `ORDER BY score DESC`.

Results merged by `(knowledgeId, chunkIndex)` and ranked via **Reciprocal Rank Fusion** (`sum over sources of 1/(60 + rank)`). Chunks in both sources get a double contribution; chunks in one still place reasonably. Output carries both scores. `websearch_to_tsquery` is forgiving — empty tsquery on all-stopwords returns zero lexical rows and the fusion quietly degrades to vector-only.

### Abuse limits

| Layer | Check | Where |
|---|---|---|
| Rate limit | 30 upload-requests / user / min | `checkRateLimit('knowledge-upload', …)` in upload-request |
| Per-workspace bytes cap | tiered per plan (50 MB / 2 GB / 1 GB / 1 GB — `shared/config/tiers.ts`) | DB count/sum at upload-request + confirm |
| Per-user caps | tiered files (5 / 50 / 500 / 2000) + bytes (50 MB / 2 GB / 10 GB / 50 GB) across ALL workspaces | DB count/sum at upload-request + confirm |
| Workspace-per-user cap | tiered owned workspaces (defaults 1 / 10 / 30 / 100 — `getTiers()[plan].workspacesOwned`) | `POST /api/workspaces` |
| Concurrent races | Valkey inflight counters (`knowledge-upload-ws` + `knowledge-upload-user`), 6 min TTL | `reserveInflightSlot` / `releaseInflightSlot` (fail CLOSED) |
| Confirm race | Postgres advisory lock `pg_advisory_xact_lock(hashtext(wsId))` inside a txn | confirm endpoint |
| Content-type bypass | Magic-byte sniff via `file-type` on first 4 KB of S3 object | `fileTypeGuard.ts`, called in confirm |
| Chunk-count abuse | `maxChunksPerFile = 300` sentinel-truncation | `chunkMarkdown` in `processKnowledge` |
| Abandoned `failed` rows | TTL sweep: `status='failed'` rows older than `failedRetentionDays = 7` auto-reaped | `server/plugins/knowledge-sweep.ts` |
| Stuck `processing` rows | TTL sweep: `status='processing'` rows older than 10 min re-process | same plugin |

Tiered caps live in `shared/config/tiers.ts` (`DEFAULT_TIERS` + `KNOWLEDGE_PLATFORM_LIMITS`; enforcement resolves via `server/utils/tierConfig.ts#getTiers()`, which applies optional `TIER_*` env overrides — see `.env.example`). The inflight counter fails CLOSED (correctness cap); the rate limit fails OPEN (DoS protection, not a cost cap). The advisory lock is load-bearing: without it, two concurrent confirms that both read N-1 used at upload-request time would both commit and land at N+1.

### Content-type validation

`file-type` sniffs the first 4 KB fetched via S3 Range GET (`bytes=0-4095` — enough for the package's internal readers, including ZIP-inside-ZIP inspection for Office formats). Allowlist per ext: PDF → `application/pdf`; DOCX/PPTX/XLSX → the specific Office MIME; XLS → `application/vnd.ms-excel` OR `application/x-cfb`. Text formats (MD/TXT/HTML/HTM) have no reliable magic — we instead decode as strict UTF-8 and check ≥90% printable chars on the first 1 KB. Mismatch → 415 + orphan S3 delete + slot release.

### AI integration

The two knowledge tools (`search_knowledge`, `get_knowledge_file`) are in `KNOWLEDGE_TOOL_DECLARATIONS`, separate from `ALL_TOOL_DECLARATIONS`, and are ONLY passed to `runAgenticLoop` when both: (a) session has `workspaceId` AND (b) workspace has ≥1 ready file. The system prompt also appends a `<knowledge_files>` block listing `{knowledge_id, filename, sizeBytes, ext, tokenCount}` — fabricated knowledge_ids are explicitly rejected. `AiSession.workspaceId` flows from `/api/ai/prompt` resolution → `createAiSession` → tool handlers, which double-check scope as defense in depth.

### UI

`WorkspaceKnowledgePanel.vue` drives upload + list + delete with XHR progress tracking and 5s-interval status polling. Mounted in two places: the workspace overview (`app/pages/w/[id].vue`) with the full header, and the editor's right sidebar (`EditorLayout.vue`) with `compact` prop. Delete uses `WorkspaceKnowledgeDeleteConfirmModal.vue`.

## Knowledge gotchas

- **Embed per-chunk with bounded concurrency** — the pipeline loops one `/v1/embeddings` call per chunk (`CONCURRENCY = 5`) and validates the vector shape (`[embeddings] <model> returned a vector with wrong shape` throws rather than silently inserting a wrong-dims row).
- **Same-dimension model swaps are invisible to the column check** — only the `embedding_version` tag (and `bun run knowledge:reembed`) tells models apart. Two different `custom-embeddings` upstreams without `EMBEDDINGS_UPSTREAM_MODEL` reaching the app produce identical tags; use `--force` once.
- **`knowledge:reembed` retypes the column only after taking the lock and `LOCK TABLE … ACCESS EXCLUSIVE`** — the old vectors are DISCARDED (`USING NULL`); the stored `content` is the source for re-embedding, so the original S3 files (deleted after processing) are never needed.
- **Jina v5-text-small is 1024-d native; v5-text-nano is 768-d native.** We pin v5-text-nano so no MRL truncation is needed and the existing `vector(768)` HNSW index is a perfect fit (zero DDL). Bumping to v5-text-small via MRL-truncate-to-768 is a config-only change if quality ever becomes the bottleneck.
- **LiteLLM's native Jina embeddings provider has a spend-tracking bug** — Jina returns `usage.total_tokens` only (no `prompt_tokens`), but LiteLLM computes embedding cost as `input_cost_per_token × prompt_tokens`, so spend lands at `$0.00`. We work around this with a custom embeddings provider in `infra/litellm/custom_handlers.py:JinaEmbeddingsProvider` (registered as `jina-embed/...` in `custom_provider_map`) that hits Jina directly and reshapes the usage so `prompt_tokens == total_tokens`. The wrapper has the same OpenAI-shape interface as the native provider — callers don't see the difference, but spend now tracks correctly. File a similar wrapper if any future provider's usage shape doesn't match LiteLLM's expected fields.
- **pgvector HNSW caps at 2000 dims** — larger embedding models can't use HNSW; they'd need IVFFlat or MRL truncation. We pick 768 (v5-text-nano native) for HNSW compat + cost.
- **`websearch_to_tsquery` on stopword-only input returns empty tsquery** — the `@@` predicate then returns zero rows. Hybrid search degrades to vector-only in that case rather than erroring; don't add a guard that short-circuits on empty queries or you lose useful signal on single-keyword searches.
- **Advisory locks must be INSIDE a txn** — `pg_advisory_xact_lock(hashtext(...))` only releases on COMMIT/ROLLBACK. All knowledge-confirm writes go through `db.transaction(async tx => ...)`.
- **Valkey inflight counter fails CLOSED** — if Valkey is down, `reserveInflightSlot` returns `allowed: false`. We'd rather reject uploads on Valkey outage than let uncapped concurrent uploads through.
- **`file-type` returns undefined on plain-text input** — no magic bytes for MD/TXT/HTML. The guard falls through to a printable-UTF-8 ratio check on the first 1 KB. Don't treat `undefined` as "unknown format = allow"; that's an allowlist bypass.
- **Knowledge S3 original is deleted after processing** — `deleteKnowledgeArtifact` still tries to delete on row-delete, tolerating 404. Don't assume `workspace_knowledge.s3_key` points at a live object for `ready` rows.
- **`processKnowledge` re-checks row existence after conversion AND after embedding** — user can delete mid-pipeline; without the re-check we'd waste embedding calls on a doomed insert.
- **`pgvector/pgvector:pg16` over stock `postgres:16-alpine`** — data-dir-compatible drop-in. Migration `0005` hand-prepends `CREATE EXTENSION IF NOT EXISTS vector` because drizzle doesn't emit extension DDL.
- **Confirm-endpoint input binding:** the knowledge-confirm handler requires `knowledgeId` to match the last path segment of `s3Key` — closes the "mint a presign for key A but claim it under knowledgeId B" surface.
- **Mid-session workspace membership drift:** `/api/ai/prompt` resolves `session.workspaceId` once at session open. Knowledge tool handlers re-check `getMemberRole(workspaceId, initiatorUserId)` on every invocation via `verifyWorkspaceMembership()` so an admin demotion mid-session immediately revokes further knowledge access at the next tool call.
