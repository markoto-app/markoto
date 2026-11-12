# Server: access control, sessions and background work

How the Nitro server in `server/` decides who may do what, how sessions and document tokens work, and which background jobs run. Agent rules for this folder live in `server/AGENTS.md`; this page explains the model behind them.

## Layout

| Path | Contents |
|---|---|
| `server/api/` | REST routes, mounted at `/api/*` |
| `server/routes/` | Other routes: OAuth and OIDC sign-in (`routes/auth/`), per-workspace SSO (`routes/auth/sso/`), SCIM (`routes/scim/v2/`), published pages (`routes/p/`), the dictation WebSocket (`routes/api/ai/dictate.ts`), `robots.txt`, `sitemap.xml` |
| `server/middleware/` | Runs on every request, in file-name order: `00.custom-domain.ts`, `auth.ts`, `csrf.ts`, `onboarding.ts` |
| `server/plugins/` | Startup hooks and periodic jobs; numeric prefixes order the ones that must run first (`00-db-migrate.ts`) |
| `server/repos/` | The only code that queries the database, one file per table family (`server/repos/AGENTS.md`). `repos/proofs/` defines the capability proofs, `repos/access/` the authorization bootstrap reads, `repos/transaction.ts` the one transaction mechanism; the `users` row is split by concern: `users.ts` (lookups, session epoch), `userSignIn.ts` (OAuth upsert), `userPolicies.ts` (policy acceptance), `userDeletionRequests.ts`, `userBilling.ts` (plan + Stripe columns) |
| `server/utils/<domain>/` | Orchestration grouped by domain (auth, documents, workspaces, billing, knowledge, storage, rendering, privacy, platform, …). Nitro auto-imports from every sub-folder. A long route keeps its declaration (access, schemas, rate limits, error codes) and calls a use-case function here: `ai/prompt.post.ts` → `agentic/sessions/editorPrompt.ts`, the `@ai` trigger → `agentic/sessions/commentTrigger.ts`, the member invite → `workspaces/inviteMember.ts`, the plan checkouts → `billing/proCheckout.ts`, `billing/workspaceCheckout.ts` |
| `server/db/` | The schema (`schema/`, one file per domain), the connection (`client.ts`), the boot migrator and the LiteLLM spend-log pool; imported only by `server/repos/` (`server/db/AGENTS.md`, [database.md](database.md)) |
| `server/utils/access/` | The access layer: decides document and workspace access and mints the proofs repo functions take |
| `server/utils/api/` | The handler contract: `defineApiHandler`, the `allow.*` access policies, `apiError` ([api-handlers.md](api-handlers.md)) |
| `server/error.ts` | Nitro error handler: 4xx pass through, 5xx become a generic message with `code: 'internal'` |

## Request pipeline

1. `plugins/00-public-page-host.ts` (a `request` hook) classifies the host. On the published-pages host (`NUXT_PUBLISH_PAGES_HOST`) or a live custom domain it drops the incoming `Cookie` header and blocks every `Set-Cookie` on the response (`utils/publish/publicHost.ts`).
2. `middleware/00.custom-domain.ts` serves those hosts: only `/p/<slug>` (or the custom domain's single page), the page's files under `/api/published/…`, `/vendor/…` and `robots.txt`, GET and HEAD only. On the app's own origin it redirects `/p/<slug>` to the pages host when one is configured.
3. `middleware/auth.ts`:
   - Internal routes (`utils/platform/internalRoutes.ts#classifyInternalRoute`): `/api/internal/**` (sync server → app), the Traefik HTTP-provider route, and the renderer's `/_internal/render/**` + `/api/_internal/render-bootstrap`. A request to any of them that carries an edge-proxy header (`X-Forwarded-Host`, `X-Forwarded-Server`, `X-Real-IP`, `Forwarded`) gets 404. `/api/internal/**` also needs `X-Internal-Secret` (`requireInternalSecret`, timing-safe, accepts the previous secret during rotation — `shared/utils/security/internalSecret.ts`). The public Traefik routers exclude these prefixes as well; `scripts/selfhost-check.sh` asserts it.
   - Every other `/api/*` route is default-deny: it needs a validated session unless it matches an entry in `utils/auth/publicRoutes.ts`. Public routes do their own gating in the handler.
4. `middleware/csrf.ts` (rules in `utils/auth/csrf.ts`): on POST/PUT/PATCH/DELETE under `/api`, a present `Origin` must name the request host or `NUXT_SITE_URL`; otherwise `Sec-Fetch-Site` must be `same-origin`/`none`; otherwise `Referer` must match. Requests with none of the three pass (non-browser clients carry no ambient cookie). Exempt: `/api/webhooks/*`, `/api/internal/*`. Refusal: 403 `csrf/origin-mismatch`.
5. `middleware/onboarding.ts` (legal surfaces on only): a signed-in user without age confirmation or current Privacy/ToS acceptance gets 403 `onboarding/required` on state-changing `/api` calls, except the paths listed in `utils/privacy/onboardingGate.ts`.
6. The handler's own declaration (`defineApiHandler`, [api-handlers.md](api-handlers.md)): instance switch, the access policy (session or service credentials, then object-level access), input schemas, plan, rate limits, idempotency. Outside `/api` (sign-in, SCIM, published pages) this is the only gate.

## Document access

| Mode | Anonymous / signed-in non-member | Owner |
|---|---|---|
| `private` (default for signed-in creators) | forbidden | full control |
| `open-edit` (default for anonymous docs) | edit | full control |
| `open-view` | view | full control |
| `password-protected` | after entering the password | full control |

Workspace roles override the mode for documents in the workspace: admin and editor get full edit everywhere, viewer is read-only everywhere (also on `open-edit`). A guest (`role = 'guest'`) reaches only documents shared with them through `document_shares` and is treated as editor or viewer for that one document.

All decisions are pure functions in `shared/utils/documents/docPermissions.ts`: `decideTokenAccess` (the editor token and every server-side write), `decideFileAccess` (images, PDF, brand files), `decideActivityAccess` (activity feed, diff, comment context), `decideDocDelete`, `canDownload` (view-only links). Their input is a `DocState` built by `docStateOf(row)` from `getDocWithActorRole` (`server/repos/access/docAuthz.ts`), which also applies:

- **Share-link expiry** — once `share_expires_at` has passed, a public mode acts as `private` for visitors.
- **SSO enforcement** — in a workspace with an active SSO connection, members without a current SSO grant have no role, and an owner without one loses owner rights (`ownerAccessSuspended`). See `server/utils/sso/AGENTS.md`.

Server-side content writes (AI prompt, `@ai` trigger, restore, dictation token, image uploads) declare `allow.doc('write-content')`, decided by `canWriteDocContent` (`utils/access/docProof.ts`), which allows exactly what `decideTokenAccess` would mint a writable token for.

### Proofs: where the decision is enforced

A decision is turned into a capability proof (`DocAccess<level>`, `WorkspaceAccess<level>`, `UserScope`, `AdminActor`, `SystemActor`) by the access layer, and every repo function that writes or returns tenant-private data demands one and takes the object id from it. The handler policies mint them (`ctx.docAccess`, `ctx.workspaceAccess`, `ctx.self`, `ctx.adminActor`), and a handler that reaches a second object (the target workspace of a move or copy, the workspace behind a document, a document named in the body) asks `ctx.prove.workspace(id, need)` / `ctx.prove.doc(id, kind)` (`utils/api/policyProver.ts`), which proves for the authenticated caller only; the MCP tool wrapper, the AI tools and the SSO / SCIM flows ask `utils/access/` (`proveDocMembership`, `proveWorkspaceAccess`, `proveScimWorkspace`); background jobs use a named `system('<job>')`. Each access-layer entry point that mints from a user id may be used only by the files listed for it in `PROOF_ENTRY_CALLERS` (`scripts/lint/proofRules.mjs`, ESLint `markoto/proof-entry-imports`), and no cast, `any` / `never` value or ts-comment may stand in for a proof (`markoto/no-proof-forgery`). So a handler that forgets a check cannot reach another tenant's rows with an id from the URL: it has no proof for them. Repo functions that cannot take a proof (authorization bootstrap, billing keyed by the paying subject, public reads, plumbing) are listed with their reason in `tests/unit/access/repoProofs.test.ts`; any other exported repo function without a proof fails that test. What this does and does not guarantee, and what row-level security would add: `docs/SECURITY-HARDENING.md` → Tenancy.

A document restricted by a moderation decision stays private until an admin lifts it: every path that widens access (access mode, password, shares, workspace move, publishing) calls `assertNotModerationRestricted` (`utils/privacy/moderationRestriction.ts`).

Workspace actions use the helpers in `utils/access/workspaceAccess.ts`: `canEditDoc` (content), `canManageDoc` (sharing, access mode, delete), `canManageWorkspace` (workspace admin actions). The last admin of a workspace cannot be demoted or removed (409, `LastAdminError`).

### Anonymous documents

Creating a document without an account sets the httpOnly `markoto-anon-creator` cookie and stores its SHA-256 on `documents.anon_creator_key_hash`. Only that browser may delete the document (`decideDocDelete` with `actor.isAnonCreator`). On instances with the anonymous gate on (`NUXT_ANON_GATE_ENABLED`, default follows `NUXT_LEGAL_SURFACES_ENABLED`), anonymous creation and anonymous abuse reports also need Terms acceptance and a fresh ALTCHA solution, verified in the app (`utils/anonGate/`, codes in `shared/config/anonGate.ts`).

### Document passwords

`POST /api/docs/:id/password` sets (owner or workspace admin, minimum `DOC_PASSWORD_MIN_LENGTH` from `shared/config/docPassword.ts`) or verifies a password. Verification works only while the mode is `password-protected` and is rate-limited per client, per document, and by a per-document failure budget (`utils/documents/docPasswordLimits.ts`). A successful verify returns a document JWT; the visitor sends it as `Authorization: Bearer` to `/meta`, `/file-token` and `/api/files`.

## Document tokens

| Minted by | Claims | Lifetime | Accepted by |
|---|---|---|---|
| `GET /api/docs/:id/token` | `docId`, `userId`, `readOnly` | 2 h, shortened to the share-link expiry (`utils/documents/docJwt.ts`) | the sync server (must match the document name) |
| `utils/storage/fileAccessToken.ts` | `scope: 'file-access'`, `docId` | 5–15 min | `/api/files` and `/api/docs/:id/brand/:file` only |
| `utils/rendering/renderTokens.ts` | `scope: 'render'`, `docId`, `snapshotId`; signed with the internal secret | 60 s | the renderer's print page and `render-bootstrap` |
| `POST /api/ai/dictate/token` | `userId` (own secret, falls back to `JWT_SECRET`) | 60 s | first message on the dictation WebSocket |
| AI, restore, comment and MCP Y.js clients (`utils/ai/aiClient.ts`, `utils/documents/restoreDoc.ts`, `utils/documents/commentsServerClient.ts`, `utils/mcp/mcpHocuspocusClient.ts`) | synthetic user id | 5–10 min | the sync server |

`hasValidDocJwt(event, docId, scopes)` (`utils/documents/docTokenVerify.ts`) refuses any scoped token unless the caller lists that scope. The token endpoint returns `token: null` for a forbidden or password-gated document, so no client can connect speculatively.

Sync connections end when their authorization ends: each connection closes when its token expires (the client renews in place shortly before). When access gets stricter the app calls `notifySyncReauthDocument(docId)` (`utils/documents/syncNotify.ts`): the sync server stores a cutoff and refuses doc tokens issued before it, and closes the document's connections so each client fetches a new token. When one user loses access (role change, removal, unshare, SCIM deactivation) the app calls `notifySyncKickUser`, which closes that user's sockets; the client then refetches its token.

## Sessions

- Sealed-cookie sessions from `nuxt-auth-utils`, 7-day max age (`nuxt.config.ts`). `SESSION_VERSION` in `utils/auth/validatedSession.ts` invalidates every older cookie.
- Each sign-in seals `users.session_epoch` into the cookie as `e`. "Log out everywhere" (`POST /api/user/sessions/revoke`) and an account-deletion request bump the epoch; a cookie with an older epoch is rejected and cleared (`utils/auth/sessionPolicy.ts`).
- `requireRecentLogin(event)` requires a sign-in at most 12 h old, else 401 `auth/reauth-required`. Used by account deletion, data export and saving/deleting a BYOK provider key.
- No cookie before sign-in: h3 would send a `nuxt-session` cookie whenever a cookieless request reads the session. `plugins/session-cookie.ts` (rules in `utils/auth/sessionCookie.ts`) and `server/error.ts` drop that `Set-Cookie` when the request carried no session cookie and the session is empty.

### Sign-in providers and account linking

`routes/auth/github.get.ts` and `google.get.ts` use `nuxt-auth-utils`; `routes/auth/oidc.get.ts` uses `openid-client` through `utils/oidc/` because the `nuxt-auth-utils` OIDC handler does not verify the ID token. All three call `upsertOAuthUser` (`server/repos/users.ts`), then `bootstrapAdminFromEnv`, then set the session.

- Identity keys: `users.github_id`, `users.google_id`, and for OIDC the pair `(oidc_issuer, oidc_subject)`. Never the email.
- Only a verified email is stored (`utils/auth/oauthEmail.ts`, `utils/oidc/profile.ts`); an unverified one is stored as NULL.
- A first sign-in merges into an existing account only if the incoming email is verified, matches case-insensitively, and that account has no identity of the same provider yet.
- OIDC settings (`NUXT_OAUTH_OIDC_*`) are validated at boot by the env registry rules (`shared/env/rules/auth.ts`, run from `plugins/01-validate-secrets.ts`).

Admin access is the `users.is_admin` column (`requireAdminUser`, `utils/auth/adminAccess.ts`). `NUXT_ADMIN_USER_EMAILS` only promotes a matching verified email at sign-in.

## Errors

A handler refuses with `apiError(code, params)` (`server/utils/api/apiError.ts`). Every code is registered in `shared/api/errors/<namespace>.ts` with its HTTP status and the `data` fields it carries; its text is `apiErrors.<namespace>.<slug>` in the six `i18n/locales/errors/<locale>.json` files. The response keeps the flat shape `data: { code, ...params }` and an English `message` rendered from the same catalog (for API and MCP clients, and logs); the browser shows the translated text by code (`useErrorHandler`). In dev and test runs `server/error.ts` logs `[api-error] unregistered code` for a 4xx whose code is not in the registry. `tests/unit/repoHygiene/apiErrorKeys.test.ts` keeps registry and texts in step and fails on a `code: '…'` literal under `server/` that is not registered.

## Audit log and idempotency

- `appendAuditEvent` (`server/repos/audit.ts`) writes the security/admin trail. It truncates the IP (/24 IPv4, /48 IPv6) itself, never throws (failures go to Sentry), and fills `workspace_id` from the scope for `workspace` and `billing` events; document events pass `workspaceId` explicitly so the workspace audit viewer finds them.
- `activity_log` is the user-facing per-document feed. Do not mix the two.
- `withIdempotency(event, scope, userId, fn)` (`utils/platform/idempotency.ts`) deduplicates a POST that carries an `Idempotency-Key` header: the first request claims the key in Valkey, the result is cached for 5 min, a concurrent retry gets 409. Used by `POST /api/docs/:id/duplicate`.

## Background jobs

Every periodic job is one plugin file in `server/plugins/` that calls `defineSweeper` (`utils/platform/defineSweeper.ts`). The helper implements the shared behaviour once: startup delay and interval, no overlapping runs in one process, the cross-instance advisory lock (`repos/sweepLocks.ts`, so only one app instance runs each job), waiting for migrations (`utils/platform/migrations.ts`), one log line per run that returns a summary, failures logged and sent to Sentry (throttled), and timers cleared on Nitro `close`. Nothing is scheduled during the build's prerender.

To add a sweeper: add a row to `SWEEPS` in `server/config/sweeps.ts`, then add a plugin file:

```ts
export default defineSweeper({
  name: 'waitlist-sweep',          // log prefix, Sentry tag AND lock key: do not rename later
  schedule: SWEEPS.waitlist,
  run: runWaitlistSweep            // return a summary object to have it logged
})
```

Options for the exceptions: `enabled` (checked once at boot, e.g. `isBillingEnabled`), `setup` (boot warning when enabled), `shouldRun` (per tick, before the lock), `runAtBoot: false`, `lock: false` / `awaitMigrations: false` (process-local work like `yDocPoolSweep`), `reportErrors: false` (transient failures such as a LiteLLM that is still starting), `onClose`. Queue-style work claims rows with `SKIP LOCKED` inside its `run`; it still goes through the helper.

| Plugin | Interval | Does |
|---|---|---|
| `orphan-cleanup` | hourly | unconfirmed or untracked upload objects, prefixes of deleted docs, knowledge / design-import / published-page leftovers |
| `image-gc-sweep` | 6 h | confirmed images referenced nowhere for `NUXT_IMAGE_GC_RETENTION_DAYS` (`utils/storage/imageGc.ts`) |
| `inactive-doc-sweep` | daily | anonymous docs inactive for `NUXT_INACTIVE_DOC_TTL_DAYS` (`utils/documents/inactiveDocSweep.ts`) |
| `knowledge-sweep` | 2 min | re-processes stuck knowledge files, removes old failed ones |
| `ai-session-sweep` | 1 min | aborts stale AI sessions |
| `ai-records-sweep` | daily | retention purge of AI session records (`utils/ai/aiRecordsSweep.ts`) |
| `audit-log-sweep`, `abuse-report-sweep` | daily | retention purges (`utils/privacy/legalRetentionSweep.ts`) |
| `account-deletion-sweep` | hourly | runs the purge for accounts past their grace period (`utils/privacy/accountDeletionSweep.ts`) |
| `data-export-worker` / `data-export-expiry-sweep` | 1 min / hourly | builds queued exports / expires old ones |
| `waitlist-sweep`, `workspace-invite-sweep` | hourly | unconfirmed waitlist sign-ups, expired invites |
| `mcp-sessions-sweep` | daily | old MCP sessions |
| `custom-domain-recheck` | 15 min | DNS re-checks of custom domains (only with `NUXT_PUBLISH_DOMAINS_TARGET`) |
| `litellm-key-reconcile` | at boot + 6 h | aligns LiteLLM keys and teams with plans (`utils/litellm/keyReconcile.ts`) |
| `spend-logs-sweep` | daily | LiteLLM spend-log retention |
| `webhook-event-sweep`, `workspace-budget-alerts`, `ai-credit-settlement` | daily / 15 min / hourly | billing jobs, started only with billing on ([billing.md](billing.md)) |

## Other subsystems

- History and restore: `utils/documents/historyReplay.ts` rebuilds a past document from the `yjs_updates` log up to a boundary id stored on the activity row (all access to that table is in `repos/yjsLog.ts`); `textDiff.ts` caps a diff at 200 hunks; `restoreDoc.ts` serialises restores per document with `pg_advisory_xact_lock`. The UI side is in `app/components/collab/AGENTS.md`.
- Server-rendered PDF and page images: `utils/rendering/renderClient.ts` flushes pending edits on the sync server, then renders through the renderer container, cached in S3 by snapshot id. A failed render is an error; there is no fallback to browser printing.
- Workspace knowledge base: [knowledge-base.md](knowledge-base.md). Billing and plan limits: [billing.md](billing.md). Migrations: [database.md](database.md).
