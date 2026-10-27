# Server-side Conventions

Nitro API + sync notification layer for markoto. Most cross-cutting code in this directory is organized as:

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

**No metadata for denied callers.** `GET /api/docs/:id/meta` uses the token endpoint's decision (`decideTokenAccess`): a forbidden / password-gated caller gets only `{docId, accessMode, hasPassword, requiresPassword, forbidden}`. A visitor who unlocked a password doc proves it with the `/password` JWT (`Authorization: Bearer`, `hasValidDocJwt`) and gets the full shape (the editor hydrates theme + doc context from it after the unlock — `useDocToken.hydrateAfterUnlock`). The denied `/token` response likewise nulls owner / workspace / role / sponsor / theme / `initialBody` and omits description / audience / language. The doc page sets its `<title>` client-side from Y.js only, so SSR never renders a private doc's title.

**Anonymous docs: creator-only delete (`utils/anonCreator.ts`).** Anonymous creation sets the httpOnly `markoto-anon-creator` cookie (random 256-bit key, one per browser, path `/api/docs`, 1 year) and stores its SHA-256 on `documents.anon_creator_key_hash`. `decideDocDelete` allows deleting an ownerless doc only with `actor.isAnonCreator` (key matches, constant-time). Others can still edit the open-edit doc. Legacy anon docs (NULL hash) are not deletable through the API; the inactive-doc sweep removes them. `/token` returns `canDelete` (server-computed) so the File menu only offers Delete when it would work.

**Doc password (`POST /api/docs/:id/password`).** Set: owner / workspace admin, min length `DOC_PASSWORD_MIN_LENGTH` (8, `shared/config/docPassword.ts`; existing shorter passwords keep verifying). Verify: only while `accessMode === 'password-protected'` (400 otherwise); the granted `readOnly` comes from `decideTokenAccess` (a workspace viewer stays read-only; non-members get edit); brute-force limits in `utils/docPasswordLimits.ts` (per client /64 + doc, per doc, per-doc failure budget). `updateDocMeta` clears `password_hash` whenever `accessMode` leaves password mode, and duplicate only copies the hash of a password-protected source.

**Server-side write paths follow the token rule.** `requireDocEditAccess` / `canWriteDocContent` (`utils/documentAccess.ts`) allow exactly what `decideTokenAccess` would mint a writable token for: owner + workspace admin/editor everywhere, other signed-in users only on `open-edit`, and never a workspace viewer (viewer wins over the public edit grant). Used by AI prompt, `@ai` comment trigger, restore, dictation token, image upload request + confirm.

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

**Revocable sessions (`utils/sessionPolicy.ts`).** Every sign-in seals `e` = `users.session_epoch` into the cookie (OAuth/OIDC handlers + `_test/login`); `resolveValidatedUser` rejects + clears a cookie whose `e` differs (missing `e` counts as 0 = column default, so the rollout logged nobody out). `POST /api/user/sessions/revoke` ("Log out everywhere" on the profile page) bumps the epoch and clears the caller's cookie; `POST /api/user/delete` bumps it too and re-seals only the requesting browser (so it can cancel). **Recent sign-in:** `requireRecentLogin(event)` (in `validatedSession.ts`) = validated session + `loggedInAt` ≤ 12 h old, else 401 `auth/reauth-required` (`messageKey: auth.reauthRequired`); used by account delete, data-export request and BYOK provider save/delete. The client handles the code via `useErrorHandler().handleReauthRequired` (toast + "Sign in again" → `/auth/<provider>`). Doc JWTs (2 h) are not tied to the epoch — same accepted trade-off as member removal.

### Sign-in providers & account linking

`github.get.ts` / `google.get.ts` use nuxt-auth-utils; `oidc.get.ts` (WP7b, self-hosters' own IdP) uses `openid-client` via `server/utils/oidc/` because nuxt-auth-utils' OIDC handler (0.5.32) only *decodes* the ID token (no signature / iss / aud / exp check). All three call `upsertOAuthUser` → `bootstrapAdminFromEnv` → `setUserSession({ provider, v: SESSION_VERSION })`, so the session version, onboarding/age gate and legal-surfaces flag behave identically.

- **Identity keys:** `users.github_id`, `users.google_id`, and for OIDC the pair `(users.oidc_issuer, users.oidc_subject)` (unique index + CHECK both-or-neither). Never the email.
- **Linking rule (all providers):** a first sign-in merges into an existing row only if the incoming email is verified AND matches (case-insensitive) AND that row has no identity of the same provider yet (an OIDC identity is never re-pointed to another issuer/sub). Otherwise a new row.
- **GitHub / Google email:** same rule as OIDC — only a verified address is used (`utils/oauthEmail.ts`): Google needs `email_verified === true`; GitHub's profile email is checked against `/user/emails` (or the verified primary is used). Unverified → stored as NULL.
- **OIDC email:** used only when the IdP sends `email_verified === true` (JSON boolean). An unverified email is dropped before the upsert (stored as NULL) — not stored, not merged, not matched against `NUXT_ADMIN_USER_EMAILS`, not findable by workspace invites — so a later GitHub/Google login can't merge into an IdP account carrying someone else's unverified address. `server/utils/oidc/profile.ts`.
- **OIDC protocol** (`server/utils/oidc/client.ts`): discovery (issuer must match), auth code + PKCE S256 + state + nonce, ID token required, signature via JWKS (`enableNonRepudiationChecks`, asymmetric algs only), iss/aud/azp/exp/nonce, RFC 9207 `iss` param when advertised, UserInfo `sub` must match. Per-attempt state/nonce/verifier live in one HMAC-signed (session password), httpOnly cookie on `/auth/oidc`, 10-min TTL, deleted on callback. Discovery cached 1 h. Failures → 401 `auth/oidc-failed` (details only in the server log), unreachable IdP → 502 `auth/oidc-unavailable`, not configured → 404.
- **Config** (`server/utils/oidc/settings.ts`, validated at boot by `plugins/01-validate-secrets.ts`): `NUXT_OAUTH_OIDC_{ISSUER,CLIENT_ID,CLIENT_SECRET}` all-or-nothing, issuer https (http only with `TEST_MODE=1` / `NODE_ENV=development`), optional `_SCOPES`, `_REDIRECT_URL` (else `NUXT_SITE_URL` / request origin + `/auth/oidc`), `_NAME` (button label, read by `shared/config/instance.ts`). The OIDC button is listed first when configured.
- **Tests:** `tests/unit/oidc.test.ts` (settings, claim mapping, flow cookie), `tests/repos/usersOidc.test.ts` (linking), `tests/integration/endpoints/oidcLogin.test.ts` (full round trip + every ID-token check against the `oidc-test` mock IdP container).

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
- **Invite = pending invitation + accept (`workspace_invites`).** `POST /api/workspaces/:wsId/members` (admin) creates/refreshes a pending invite for the normalised email and answers `202 {ok, invited}` whether or not the address has an account — no profile data, no existence oracle; only 409 when the address already belongs to a member. Membership is created ONLY when the invitee accepts: in-app (`/api/user/invites/:inviteId/accept|decline`, invite email must equal the account's verified email) or via the emailed single-use link (`/invites/accept?token=…` → `POST /api/user/invites/by-token`; the token proves the mailbox, account email may differ). Accept is one transaction (row lock, member insert ON CONFLICT DO NOTHING keeps an existing role, invite delete). Admins list/revoke open invites (`GET /api/workspaces/:wsId/invites`, `DELETE …/invites/:inviteId`, keyed on (workspace, invite id)). Limits: 20/h per admin, 30/h per workspace, ≤50 open per workspace (409 `workspace/invite-cap`), ≤3 invite emails per address per day (silently skipped). 14-day expiry; `workspace-invite-sweep` deletes expired rows. Audited (`workspace.invite_created|revoked|accepted|declined`, no email in the audit row). Lawful basis `workspace_invitations`. Default role = editor. No typeahead to avoid user enumeration.
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
- `/api/_test/*` is whitelisted only while test mode is active (`isTestModeEnabled`, `shared/utils/testMode.ts`); otherwise it falls to default-deny and the handlers 404.
- **`middleware/csrf.ts`** — Origin / `Sec-Fetch-Site` / Referer check on POST/PUT/PATCH/DELETE under `/api` (rules in `utils/csrf.ts`): a present Origin must name the request Host or `NUXT_SITE_URL`; `Sec-Fetch-Site` must be `same-origin`/`none`; requests with none of the three (non-browser clients) pass. Exempt: `/api/webhooks/*`, `/api/internal/*`. 403 `csrf/origin-mismatch`.
- **`middleware/onboarding.ts`** — legal surfaces on only: a signed-in user without age confirmation or current Privacy/ToS acceptance gets 403 `onboarding/required` on state-changing `/api` calls; exemptions in `utils/onboardingGate.ts` (accept, logout, consent, delete/cancel, export, waitlist confirm/unsubscribe, webhooks/internal/test). Acceptance state comes from the same per-request user lookup as `requireValidatedUserSession` (`getValidatedOnboardingState`).

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

- `orphan-cleanup` — hourly: unconfirmed image uploads (24 h), untracked objects under live doc prefixes, deleted docs' prefixes, and knowledge objects (final or staging) with no `workspace_knowledge` row after 1 h (`utils/knowledgeOrphanSweep.ts`).
- `image-gc-sweep` — every 6 h: deletes confirmed doc images referenced nowhere (doc, restorable history, other docs, themes, comments) for `NUXT_IMAGE_GC_RETENTION_DAYS` (default 30, 0 = off). See `utils/imageGc.ts`.
- `ai-session-sweep` — aborts AI sessions older than 7 min (above the 5-min prompt deadline).
- `ai-records-sweep` — enforces the privacy policy's 90-day retention on AI prompt/tool-call records (`ai_session_messages`) + reaps orphaned `ai_sessions` past 90 days. Distinct from `ai-session-sweep` (that's a 7-min in-flight abort; this is the GDPR retention purge). See `server/utils/aiRecordsSweep.ts`.
- `inactive-doc-sweep` — flags stale anonymous docs.
- `knowledge-sweep` — retries stuck-processing rows (10 min TTL) + reaps `failed` rows (7 day TTL).
- `webhook-event-sweep` — prunes `processed_webhook_events` (>90d) and `pending_stripe_events` (processed >7d, unprocessed >30d). **Only starts when `NUXT_BILLING_ENABLED` is on.** See `server/utils/AGENTS.md`.
- `plan-lapse-sweep` — disables `(+)` team-billing on workspaces whose billing owner deleted their account, lapsed, or downgraded below Max/Ultra. **Only starts when `NUXT_BILLING_ENABLED` is on.** See `server/utils/AGENTS.md`.
- `workspace-invite-sweep` — hourly; deletes expired workspace invitations (`server/utils/workspaceInviteSweep.ts`).
- `waitlist-sweep` — hourly; deletes unconfirmed paid-plans waitlist sign-ups past their 7-day confirm window (`server/utils/waitlistSweep.ts`). Runs regardless of billing mode.
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
- **Admin endpoints** (`/admin/*`, `/api/admin/*`) — guarded by `requireAdminUser(event)` from `server/utils/adminAccess.ts`. Source of truth is `users.is_admin` column; `NUXT_ADMIN_USER_EMAILS` env-list is a bootstrap path applied on every OAuth/OIDC callback by `adminBootstrap.ts` — verified emails only, every provider (so a fresh deploy + a listed email = admin at first sign-in without manual `UPDATE`). The check itself reads only the column (no stored-email fallback). Both grant and revoke audit-log via `admin.granted` / `admin.revoked`.
- **Audit-log writes are best-effort.** `appendAuditEvent` in `server/repos/audit.ts` swallows + Sentry-captures failures. The user's primary action has already committed; failing the request because audit write failed would be confusing. **Always pass an IP through `truncateIp(rawIp)`** at the call site; the repo trusts the input.
- **Billing mode.** `server/utils/billingMode.ts` — `isBillingEnabled()`, `assertBillingEnabled()` (404 `billing/disabled`; called at the top of checkout / portal / Stripe webhook / workspace `(+)` PATCH), `effectivePlan()` (billing off → always `free`), and mode-aware limit copy (`limitRecovery()`, `limitUpgradeHint()`, `budgetExhausted*()`) so no error ever points at a purchase that doesn't exist. Reads `process.env` per call (like `tierConfig.ts`).
- **Paid-plans waitlist** (`/api/waitlist`, `/api/waitlist/confirm`, `/api/waitlist/unsubscribe` — all public, whitelisted in `middleware/auth.ts`). Sign-up only while billing is off AND `NUXT_PLANS_COMING_SOON` (else 404 `waitlist/disabled`); requires `consent: true`; always answers the same 202 (no "is this email on the list" oracle). Confirm/unsubscribe always work (withdrawing consent never depends on a flag). Tokens 256-bit, SHA-256-hashed at rest; confirm + unsubscribe pages POST on an explicit click so link-prefetching mail scanners can't act. Email links use `NUXT_SITE_URL` only (`utils/siteUrl.ts#emailLinkBaseUrl`; never the request Host / Origin) — unset → the email is skipped; production boot requires the variable.
- **Error sanitisation is framework-level.** `nuxt.config.ts` wires `nitro.errorHandler: '~~/server/error.ts'`. The handler exports `buildSanitizedErrorPayload` (pure, exported for testing — see `tests/unit/errorSanitizer.test.ts`): 4xx pass through (preserves `message` + `data` so `code: 'abuse/rate-limited'`-style hints reach the client); 5xx stripped to a generic message + `data: { code: 'internal' }`. Stack traces never appear. Don't add per-endpoint try/catch to "scrub" errors — the framework-level handler is canonical.

## Other server-side gotchas

- **`nitro.preset: 'bun'`** — `node-server` preset traces wrong condition for packages with Bun conditional exports (lib0).
- **Nitro NFT tracer misses `@google/genai`'s transitive `ws`** — fix with `nitro.externals.traceInclude: ['node_modules/ws/index.js']`.
- **Nitro WS requires `nitro.experimental.websocket: true`.** Without it, `defineEventHandler({ websocket })` silently ignores hooks.
- **crossws upgrade hook must RETURN void**, not `{ context }`. Returning a non-ResponseInit object corrupts the handshake (ECONNRESET, worker crash). Mutate `request.context` in-place instead.
- **Migrations that TRUNCATE optional tables need `IF EXISTS` guards.** `yjs_documents` is created lazily by y-postgresql at sync-server startup, NOT by drizzle. Wrap TRUNCATEs in `DO $$ ... IF EXISTS (SELECT 1 FROM pg_class WHERE relname = '...') THEN ... END IF; ... END $$`.
