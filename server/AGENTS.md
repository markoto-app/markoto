# Server-side Conventions

Nitro API + sync notification layer for md-online. Most cross-cutting code in this directory is organized as:

- `api/` — REST + WS routes (see `api/AGENTS.md` for the route map).
- `routes/` — top-level Nitro routes (e.g. `auth/` for OAuth, the `api/ai/dictate.ts` WS handler).
- `db/schema.ts` — Drizzle source of truth (see `db/AGENTS.md` for the migration cookbook).
- `middleware/auth.ts` — central auth guard with whitelist patterns for public endpoints.
- `plugins/` — Nitro lifecycle hooks (db migrate, shutdown, sweepers).
- `repos/` — Drizzle-backed repositories (see `repos/AGENTS.md` for conventions).
- `utils/` — orchestration helpers (see `utils/AGENTS.md`); `utils/agentic/` holds the AI loop (see `utils/agentic/AGENTS.md`).

`server/auth/` is NOT a Nitro route directory — OAuth handlers live in `server/routes/auth/`.

---

## Auth & Access Control

### Access modes

| Mode | Anonymous | Logged-in non-owner | Owner |
|---|---|---|---|
| **Private** (default for logged-in docs) | forbidden | forbidden | Full control |
| **Open edit** (default for anonymous docs) | Edit | Edit | Full control |
| **Open view** | View | View | Edit + manage |
| **Password-protected** | Enter password | Enter password | Edit + manage |

Workspace membership overrides: admin/editor bypasses `private` and `password-protected`; viewer gets read-only access regardless of accessMode.

**Read-only: 4 layers** — (1) token mints JWT with `readOnly: true`, (2) Hocuspocus blocks Y.js updates, (3) CM6 Compartments set `EditorView.editable + EditorState.readOnly`, (4) UI hides toolbar.

**Password-protected: 3 layers** — (1) token returns `token: null`, (2) Hocuspocus rejects, (3) `v-if="!requiresPassword"` blocks editor mount.

**Doc-scoped JWTs.** Three independent token surfaces are minted server-side, all signed with `JWT_SECRET` (or its scoped sibling) and all carrying a `scope` claim plus the resource id they cover:

| Mint site | Scope | TTL | Verifies on |
|---|---|---|---|
| `GET /api/docs/:id/token` | implicit doc — `{docId, userId, readOnly}` | 2h | Hocuspocus `onAuthenticate` (rejects mismatched `documentName`) |
| `server/utils/renderTokens.ts` | `'render'` + `{docId, snapshotId}` | 60s | `app/pages/_internal/render/[docId].vue` (renderer-only path) |
| `POST /api/ai/dictate/token` | dictate — `{userId}` (separate `dictateJwtSecret`, falls back to `jwtSecret`) | 60s | first WS message on `/api/ai/dictate` |
| `server/utils/aiClient.ts` (AI joins as Y.js client) | `userId='ai:assistant:{sessionId}'` | 10m | Hocuspocus, same path as user tokens |
| `server/utils/restoreDoc.ts` (synthetic restore client) | same | 5m | Hocuspocus |
| `server/utils/commentsServerClient.ts` (peek-only read) | same | 5m | Hocuspocus |

A leak of one minted token cannot pivot to another scope: `verifyRenderToken` rejects anything without `scope === 'render'`; the dictate WS handler rejects payloads missing `userId`; Hocuspocus checks `payload.docId === documentName`. Past JWT issuance is also forbidden for password-gated / forbidden docs (`token: null` from the token endpoint) so a determined client can't speculatively connect.

**Session:** 7d maxAge. `SESSION_VERSION` in `server/utils/validatedSession.ts` invalidates stale cookies on next request. OAuth handlers in `server/routes/auth/` (NOT `server/auth/`).

### Workspaces & roles

`workspace_members` is the authorization source of truth — `workspaces.ownerId` is provenance only, never read for authz. Three roles:

| Action | Viewer | Editor | Admin | Doc owner |
|---|:-:|:-:|:-:|:-:|
| View doc | ✓ | ✓ | ✓ | ✓ |
| Edit content / title / theme | — | ✓ | ✓ | ✓ |
| Change access mode / password | — | — | ✓ | ✓ |
| Delete doc | — | own only | any | own |
| Create doc in workspace | — | ✓ | ✓ | n/a |
| Add / remove members, change roles | — | — | ✓ | n/a |
| Rename / delete workspace | — | — | ✓ | n/a |
| Leave workspace | ✓ | ✓ | ✓ (if not last admin) | n/a |

- **≥1 admin invariant** enforced in `workspace_members/[userId].patch.ts` and `.delete.ts` (409 on last-admin demotion/removal).
- **Invite: exact-email only.** 404 no-such-user, 409 duplicate. Default role = editor. No typeahead to avoid user enumeration.
- **Central helpers:** `server/utils/workspaceAccess.ts` — `getWorkspaceRole`, `getDocAuthz`, `canEditDoc`, `canManageDoc`, `canManageWorkspace`, `countWorkspaceAdmins`. Additive: standalone/anonymous doc flows unchanged. **Don't mix concerns:** content-edit (`canEditDoc`) gates editing; sharing/access-mode/delete (`canManageDoc`) is a strict superset; admin actions on the workspace itself (`canManageWorkspace`) is independent. Audit-instrumented endpoints (workspace delete, member role change, member removal) call `appendAuditEvent` AFTER the privileged mutation commits.
- **Token endpoint** queries `workspace_members`: admin/editor → `readOnly: false`, bypasses `private`; viewer → `readOnly: true` always.
- **Cascade delete:** iterates all docs, calls `deleteDocument()` per-doc (S3 + Y.js + sync notify); `workspace_members` drop via FK cascade.
- **"Recent Documents"** dashboard lists only owned docs; workspace docs surface inside the workspace view.

---

## Drizzle conventions

- **`pg` driver, single stack-wide.** `y-postgresql` requires `pg.PoolConfig`; mixing drivers = two pools.
- **Text-typed enums, not `pgEnum`.** Adding values is TS-only — no `ALTER TYPE` friction. See `server/db/schema.ts`.
- **Migrations applied at boot** by `server/plugins/00-db-migrate.ts` (numeric prefix forces load-first). `99-shutdown.ts` closes the pool.
- **`bun run db:generate`** diffs against `drizzle/meta/` snapshots; commit both.
- **`drizzle/` MUST be COPYed into the runtime image** in the Dockerfile or migrations fail to apply on boot.
- **Drizzle doesn't emit `CREATE EXTENSION`** — for `vector(...)` columns, hand-prepend `CREATE EXTENSION IF NOT EXISTS vector;` + `statement-breakpoint` to the generated SQL.
- **Drizzle node-postgres returns Promises**, not `.get()`/`.all()`. Use `(await db.select()...limit(1))[0]`.
- **Slow-query log.** `useDatabase()` wraps `pool.query` with a timing probe; queries past `NUXT_DB_SLOW_QUERY_MS` (default 200) fire a warning-level Sentry event tagged `component=db, event=slow_query`. SQL is truncated to 500 chars; param VALUES are never logged (PII / secrets risk) — only `paramsCount`. Override the threshold per-environment for noisier dev or tighter prod alerting.
- **Indexes on populated tables need hand-edited `CONCURRENTLY`.** Drizzle's generated migrations always emit `CREATE INDEX` (locks the table). For empty tables (post-migration backfill, dev data) this is fine. When we add an index to `activity_log`, `workspace_knowledge_chunks`, `yjs_documents`, or any other table that's been populated in prod, hand-edit the generated SQL to `CREATE INDEX CONCURRENTLY` BEFORE applying. `CONCURRENTLY` can't run inside a transaction, so the migration has to drop its `BEGIN`/`COMMIT` wrapping too. Document the operation in the migration file's leading comment so the next reviewer knows why the file deviates from drizzle's default shape.

---

## Auth-middleware conventions

`server/middleware/auth.ts` whitelists public patterns; protects `/api/docs/` (outside whitelist), `/api/workspaces`, `/api/user`, `/api/upload`, `/api/ai`. Token endpoint never issues a usable JWT for forbidden/password-gated docs.

- Use `[^/]+` not `\d+` in whitelist regexes so a malformed id hits 400, not 401.
- New activity-log endpoints (`/diff`, `/comment-context`) are whitelisted because anonymous editors on open-edit docs need them; auth gating happens INSIDE the handlers via `decideActivityAccess`.
- `/restore` is deliberately NOT whitelisted — falls through to the protected branch.

---

## Repos

`server/repos/` exports table-bounded query helpers. **Headline rules** (see `repos/AGENTS.md` for the long form):

- **Never ship `passwordHash`.** Always project explicitly on public endpoints.
- **Cross-doc isolation via tuple keys.** `getActivityById(activityId, docId)` is keyed on the (id, docId) tuple — a row from doc B accessed via doc A's URL returns null. Same pattern across `/diff`, `/comment-context`, `/restore`. Closes the timing-oracle for "does activityId X exist on doc Y?".
- **Two append-only feeds, do not conflate.** `activity_log` is the per-doc user-facing feed (edits, comments, theme/title changes, restores) — actively read by Activity Log Tier 1/2, auto-pruned with the doc. `audit_log` (Phase 2) is the security/admin trail (`scope ∈ {doc, workspace, user, billing, system}`, append-only, IP-truncated for GDPR, NEVER user-facing) — written by `appendAuditEvent` from privileged endpoints + sweepers; readers are forensic queries only. Don't add audit-shaped events to `activity_log`, and don't surface `audit_log` rows in the activity drawer.

---

## Idempotency

`server/utils/idempotency.ts` exports `withIdempotency(event, scope, userId, fn)` — Stripe-style request dedup for race-prone POST endpoints. Header `Idempotency-Key` is required to engage; absent header means call-through with no caching. Shipping use site: `POST /api/docs/:id/duplicate` (a network retry mid-clone would otherwise leave two duplicates). Add it to any new POST whose double-execution corrupts state — clone/copy/import endpoints especially. Don't use for billing-correctness paths (those are protected at the DB level by the unique processed-events row + atomic counter UPSERT).

---

## Sweepers / plugins

`server/plugins/` runs at boot. Naming uses numeric prefixes for load order (`00-db-migrate.ts` before `99-shutdown.ts`). Background sweepers:

- `orphan-cleanup` — removes pending uploads with no DB row.
- `ai-session-sweep` — aborts AI sessions older than 7 min (above the 5-min prompt deadline).
- `ai-records-sweep` — enforces the privacy policy's 90-day retention on AI prompt/tool-call records (`ai_session_messages`) + reaps orphaned `ai_sessions` past 90 days. Distinct from `ai-session-sweep` (that's a 7-min in-flight abort; this is the GDPR retention purge). See `server/utils/aiRecordsSweep.ts`.
- `inactive-doc-sweep` — flags stale anonymous docs.
- `knowledge-sweep` — retries stuck-processing rows (10 min TTL) + reaps `failed` rows (7 day TTL).
- `webhook-event-sweep` — prunes `processed_webhook_events` (>90d) and `pending_stripe_events` (processed >7d, unprocessed >30d). See `server/utils/AGENTS.md`.
- `plan-lapse-sweep` — disables `(+)` team-billing on workspaces whose billing owner deleted their account, lapsed, or downgraded below Max/Ultra. See `server/utils/AGENTS.md`.
- `account-deletion-sweep` — claims users whose `deletion_requested_at` deadline (default 30 days) has passed and runs the full purge via `accountDeletionExecute.ts`. See `server/utils/AGENTS.md`.
- `data-export-worker` — drains `data_export_jobs` rows in `queued` state, builds the ZIP (13 standardised entries) via `dataExport.ts`, uploads to S3, marks `ready`. Failures flip the row to `failed` with a truncated message.
- `data-export-expiry-sweep` — flips `ready` rows to `expired` past their 7-day TTL and best-effort deletes the S3 object.

**EVERY new sweeper MUST acquire `acquireSweepLock(name)` before doing work and call `releaseSweepLock(name)` in a `finally`.** Without the lock, every Nuxt instance fires the same timer and runs duplicate work (correctness-OK for our sweepers since they're idempotent, but wasteful and noisy). The lock is a session-scoped Postgres advisory lock pinned to a `PoolClient` — see `server/utils/AGENTS.md` for why it's not `pg_try_advisory_xact_lock`.

---

## Stripe webhook tables

Two tables under `server/db/schema.ts` back Stripe webhook reliability:

- **`processed_webhook_events`** — Stripe replays at-least-once. We INSERT `event.id` with `ON CONFLICT DO NOTHING` and short-circuit if the row already existed. Preserves manual ops corrections that landed between original delivery and a retried redelivery.
- **`pending_stripe_events`** — Stripe webhook delivery is intentionally NOT ordered. `customer.subscription.*` and `invoice.*` events can arrive BEFORE the `checkout.session.completed` that binds the customer to the user row — a naive handler would match zero rows and silently drop. We stash unmatched events keyed on `customerId` and drain them in `received_at` order on the eventual checkout.

Implementation lives in `server/utils/stripeWebhook.ts` (dispatcher) + `server/utils/webhookEventSweep.ts` (pruner). See `server/utils/AGENTS.md` for the dispatch flow.

---

## Privacy & compliance plumbing

The legal/privacy registries (`server/legal/`) and the Vue privacy components (`app/components/legal/`) each have their own AGENTS.md. Server-side wiring summary for what's between them:

- **Account-status endpoint** (`/api/user/account-status`) is the single fetch behind `useAccountStatus()` — returns `{ageConfirmedAt, *_version_accepted, deletion_requested_at, isAdmin, workspaceFates: [...]}`. The `workspaceFates` come from `planAccountDeletion(userId)` and drive the deletion-consequences modal.
- **Account-deletion request** (`/api/user/delete`) flips `deletion_requested_at`, audits, and fires the "deletion scheduled" email. **Cancel** (`/api/user/delete-cancel` — one segment, NOT `/delete/cancel`) nulls the column and audits `account.delete_cancelled`. The actual cascade runs from `accountDeletionSweep.ts` once the deadline passes; never run it inline from the request endpoint.
- **Onboarding acceptance** (`/api/user/onboarding/accept`) writes `*_version_accepted` + `*_locale` + `age_confirmed_at` in one update via `applyOnboardingAcceptance`. Bumping a `_VERSION` constant in `shared/legal/versions.ts` invalidates prior acceptance for everyone with stale rows — no migration needed.
- **DPA acceptance** is a separate endpoint because it's workspace-owner-gated. `applyDpaAcceptance(userId, ...)` writes the row; the UI only surfaces it when the user is about to own a workspace.
- **Consent** (`/api/consent` GET + POST) is keyed on the `markoto-anon-id` cookie, NOT the user. Append-only — every save writes a new `consent_log` row. The same anon-id can have a `userId` after sign-in (post-login bridge); we never overwrite the original anonymous record.
- **Abuse-report submit** (`/api/abuse-reports`) — login-required (DSA Art.16 doesn't require the public form to be anonymous; the abuse contact email IS that public channel). Rate-limited 10/user/hour. Free-form `docId` text field, NOT FK. Snapshots reporter email + truncated IP + UA hash; reporter user FK is `ON DELETE SET NULL` so deletion preserves moderator follow-up via the email snapshot. Best-effort operator email via Resend on every submit.
- **Admin endpoints** (`/admin/*`, `/api/admin/*`) — guarded by `requireAdminUser(event)` from `server/utils/adminAccess.ts`. Source of truth is `users.is_admin` column; `NUXT_ADMIN_USER_EMAILS` env-list is a bootstrap path applied on every OAuth callback by `adminBootstrap.ts` (so a fresh deploy + a listed email = instant admin without manual `UPDATE`). Both grant and revoke audit-log via `admin.granted` / `admin.revoked`.
- **Audit-log writes are best-effort.** `appendAuditEvent` in `server/repos/audit.ts` swallows + Sentry-captures failures. The user's primary action has already committed; failing the request because audit write failed would be confusing. **Always pass an IP through `truncateIp(rawIp)`** at the call site; the repo trusts the input.
- **Error sanitisation is framework-level.** `nuxt.config.ts` wires `nitro.errorHandler: '~~/server/error.ts'`. The handler exports `buildSanitizedErrorPayload` (pure, exported for testing — see `tests/unit/errorSanitizer.test.ts`): 4xx pass through (preserves `message` + `data` so `code: 'abuse/rate-limited'`-style hints reach the client); 5xx stripped to a generic message + `data: { code: 'internal' }`. Stack traces never appear. Don't add per-endpoint try/catch to "scrub" errors — the framework-level handler is canonical.

## Other server-side gotchas

- **`nitro.preset: 'bun'`** — `node-server` preset traces wrong condition for packages with Bun conditional exports (lib0).
- **Nitro NFT tracer misses `@google/genai`'s transitive `ws`** — fix with `nitro.externals.traceInclude: ['node_modules/ws/index.js']`.
- **Nitro WS requires `nitro.experimental.websocket: true`.** Without it, `defineEventHandler({ websocket })` silently ignores hooks.
- **crossws upgrade hook must RETURN void**, not `{ context }`. Returning a non-ResponseInit object corrupts the handshake (ECONNRESET, worker crash). Mutate `request.context` in-place instead.
- **Migrations that TRUNCATE optional tables need `IF EXISTS` guards.** `yjs_documents` is created lazily by y-postgresql at sync-server startup, NOT by drizzle. Wrap TRUNCATEs in `DO $$ ... IF EXISTS (SELECT 1 FROM pg_class WHERE relname = '...') THEN ... END IF; ... END $$`.
