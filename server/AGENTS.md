# server/

Nitro API, sign-in routes, middleware and background jobs. How access control, document tokens, sessions and the jobs work: `docs/contributing/server.md`. Folder rules: `db/AGENTS.md`, `repos/AGENTS.md`, `utils/AGENTS.md`, `utils/agentic/AGENTS.md`, `utils/sso/AGENTS.md`, `mcp/AGENTS.md`, `legal/AGENTS.md`.

## Routes and middleware

- Declare every route with `defineApiHandler` and an `allow.*` policy (`utils/api/`, `docs/contributing/api-handlers.md`); read inputs through its zod schemas and refuse with `apiError`. Never use h3's `readValidatedBody` / `getValidatedQuery`: they turn our own errors into a raw-zod 400.
- `middleware/auth.ts` is default-deny for `/api/*`. A sessionless route needs an entry in `utils/auth/publicRoutes.ts` with a comment saying why it is public and where it is gated. Use `[^/]+` for id segments so a malformed id reaches the handler's 400, not a 401.
- Service-to-service routes go under `/api/internal/` (needs `X-Internal-Secret`) or the render paths, classified in `utils/platform/internalRoutes.ts`. Requests to them carrying edge-proxy headers get 404. Never put a browser-facing route under `/api/internal/`; public reads use `/api/_internal/`. A new internal prefix must also be excluded from the public Traefik routers (`scripts/selfhost-check.sh` asserts the existing ones).
- Compare shared secrets only with `shared/utils/security/internalSecret.ts` (timing-safe, accepts the previous secret during rotation). Never `===`.
- `middleware/csrf.ts` exempts only `/api/webhooks/*` and `/api/internal/*`. Never exempt a cookie-authenticated route.
- The published-pages host and custom domains serve published pages only and never read or set a cookie (`plugins/00-public-page-host.ts`, `middleware/00.custom-domain.ts`). Never serve app pages or API routes there.
- A state-changing endpoint that a user who has not finished onboarding must reach goes in the exemption list in `utils/privacy/onboardingGate.ts`.
- The dictation WebSocket authenticates with the JWT in the first message, never in the URL.

## Document access

- Decide document access only with the pure functions in `shared/utils/documents/docPermissions.ts` (`decideTokenAccess`, `decideFileAccess`, `decideActivityAccess`, `decideDocDelete`, `canDownload`), fed by `docStateOf(row)` from `getDocWithActorRole`. Check ownership with `isEffectiveDocOwner` — never compare `ownerId` by hand: share expiry and SSO enforcement change the answer.
- Server-side content writes use `allow.doc('write-content')`, whose `docAccess` is a `DocAccess<'write'>`. The rule (`canWriteDocContent`, `utils/access/docProof.ts`) allows exactly what `decideTokenAccess` would make writable; a workspace viewer never writes, even on `open-edit`.
- Repo calls take capability proofs, never bare ids (`repos/AGENTS.md` → Proofs). A handler gets them from its policy (`docAccess`, `workspaceAccess`, `self`, `adminActor`, and `prove.workspace` / `prove.doc` for a second object, bound to the caller); other code asks the access layer (`utils/access/`: `proveDocMembership`, `proveWorkspaceAccess`, `docProofFor`). Only background jobs, webhooks and internal routes use `system('<name>')`; ESLint refuses it in user-facing handlers. Tenancy guarantees and limits: `docs/SECURITY-HARDENING.md` → Tenancy.
- Denied callers of `/meta` and `/token` get the access fields only — never title, owner, theme, body or document context.
- After a change that makes a document's access stricter (access mode, password, share expiry or no-download, moderation, workspace move), call `notifySyncReauthDocument(docId)` AFTER the write commits. After reducing one user's access (role change, removal, unshare), call `notifySyncKickUser`. Both live in `utils/documents/syncNotify.ts`.
- Every path that widens who can reach a document (access mode, password, shares, workspace move, publishing) calls `assertNotModerationRestricted` (`utils/privacy/moderationRestriction.ts`).
- `hasValidDocJwt(event, docId, scopes)` accepts a scoped token only when the caller lists its scope; only the file routes accept `file-access`. Don't widen it.
- Guests (`workspace_members.role = 'guest'`) are invisible to `getMemberRole`; they reach a document only through `document_shares`. Use `getMembershipRole` only where guests must be counted.
- Workspace authz goes through `utils/access/workspaceAccess.ts`; `workspaces.owner_id` is provenance, never an authz input.

## Sessions and accounts

- New sensitive account actions (deletion, export, credentials) call `requireRecentLogin(event)`.
- A new sign-in handler copies `routes/auth/github.get.ts`: `upsertOAuthUser`, then `bootstrapAdminFromEnv` with a verified email only, then a session carrying `loggedInAt`, `v: SESSION_VERSION` and `e: getSessionEpoch(userId)`.
- Link accounts only through `upsertOAuthUser` (verified matching email, no existing identity of that provider). Never key an identity on the email.
- Never make an anonymous request create a session cookie. `plugins/session-cookie.ts` strips the cookie h3 would set on a session read; keep code paths for anonymous users read-only on the session.
- The account purge runs only from `account-deletion-sweep`, never inline in a request.

## Writes and errors

- Call `appendAuditEvent` (`repos/audit.ts`) after the privileged mutation commits. It truncates the IP and swallows failures itself. Pass `workspaceId` on document events, or the workspace audit viewer misses them.
- Wrap a POST whose double execution corrupts state (clone, copy, import) in `withIdempotency` (`utils/platform/idempotency.ts`). Not for billing correctness — that is enforced in the database.
- Never add per-endpoint try/catch to scrub 5xx messages; `server/error.ts` does it for every route. Return client-actionable errors as 4xx through `apiError` with a registered code (`shared/api/errors/`).

## Plugins and background jobs

- Every periodic job is a plugin that calls `defineSweeper` (`utils/platform/defineSweeper.ts`) with a row of `config/sweeps.ts`. It takes the advisory lock `acquireSweepLock(name)` (`repos/sweepLocks.ts`; `name` is the lock key, never rename it) and releases it in `finally`; only per-process work, like `yDocPoolSweep.ts`, sets `lock: false`. See `docs/contributing/server.md` → Background jobs.
- A plugin that queries the database at startup first awaits `migrationsComplete` (`utils/platform/migrations.ts`): Nitro does not wait for one plugin before running the next. `defineSweeper` does this for its runs.
- Billing jobs start only when `isBillingEnabled()`.

## Nitro

- WebSocket handlers need `nitro.experimental.websocket: true` (set in `nuxt.config.ts`); without it the `websocket` hooks are ignored silently.
- `nitro.externals.traceInclude` lists `ws` because the tracer misses it inside `@mistralai/mistralai`. Add a similar entry when a bundled SDK's transitive import is missing from the build output.
