# server/repos

Drizzle-backed repositories. One file per table family — `documents.ts`, `users.ts`, `workspaces.ts`, `workspaceMembers.ts`, `uploads.ts`, `comments.ts`, `activity.ts`, `audit.ts`, `themes.ts`, `knowledge.ts`, `health.ts`. Anything cross-table (e.g. cascading delete logic) lives in `server/utils/` and calls into multiple repos.

## Conventions

### One repo per table family
A "family" is one logical owner — `documents.ts` owns `documents` + the meta projections HTTP endpoints expect; `workspaces.ts` owns the workspace row; `workspaceMembers.ts` owns membership-keyed queries because it's its own authz axis (admin-count, role lookups). When in doubt: if the new file has more than one shape of write into the same table, extend; if it pulls a third table into the join, the orchestration belongs in `server/utils/`.

### Cross-doc isolation via tuple keys
Every per-doc lookup that takes an externally-supplied id MUST be keyed on the `(id, docId)` tuple, not the id alone. `getActivityById(activityId, docId)` returns null for a row from doc B accessed via doc A's URL — closes the timing-oracle for "does activityId X exist on doc Y?". Same pattern across `/diff`, `/comment-context`, `/restore`. When adding a new per-doc resource (annotations, attachments, etc.), follow the same pattern; **don't take a bare id and trust the URL prefix.**

### Domain errors at the repo boundary
Repo functions return either a valid domain value or throw one of the classes in `errors.ts`:

| Class | HTTP | When |
|---|---|---|
| `NotFoundError` | 404 | row missing |
| `ForbiddenError` | 403 | caller authorised but action not allowed (e.g. last-admin demotion) |
| `ConflictError` | 409 | state conflict (already exists, in-flight) |
| `DuplicateError` extends ConflictError | 409 | uniqueness violation |
| `LastAdminError` extends ConflictError | 409 | the workspace ≥1-admin invariant |
| `ValidationError` | 400 | repo-level shape rejection |

Endpoints catch these and translate via `toHttpError(e)` at the end of the handler, so individual endpoints no longer spell out "throw 404 if not found" for every operation. **Never throw an HTTP status from inside a repo, never leak a `pg` error code outward** — those details stop at the repo boundary.

### Audit-log specifics
`audit.ts` is append-only by convention: it exports no `update` or `delete`. The only legitimate way for a row to disappear is the `set null` FK on `actor_user_id` (when a user account is purged) or a manual DBA action. **Failures to write audit MUST NOT propagate** — the user's primary action (delete, role change, etc.) has already committed by the time the audit row is appended; failing the request because audit failed would surface a confusing error for an action that succeeded. `appendAuditEvent` swallows + Sentry-captures internally.

`actor_ip` is truncated to /24 (IPv4) or /48 (IPv6) before storage to honour pseudonymisation under GDPR. Use the exported `truncateIp(ip)` helper at the call site rather than passing the raw IP — the repo trusts what it gets.

### Drizzle import shape
Repos import `useDatabase` from `../utils/database` and call it inline. Don't cache the handle at module scope — the pool is initialised lazily by the migrate plugin and module-scope caching breaks tests that swap the pool. `useDatabasePool()` is for low-level callers that need a `PoolClient` (advisory locks, sweep locks).

Drizzle's node-postgres adapter returns Promises, not `.get()` / `.all()`. Use `(await db.select()...limit(1))[0]` for single-row reads. `import { and, eq, lt, sql } from 'drizzle-orm'` — predicates are tree-shaken so import only what you use.

### Transaction passing
`audit.ts` and `stripeWebhook.ts` set the precedent: when a repo function is called from within a `db.transaction(async tx => …)`, accept an optional `db?: DbOrTx` parameter and pass `tx` through so reads / writes commit atomically with the caller's other work. The dispatcher in `stripeWebhook.ts` wraps the whole event in one transaction so the dedup INSERT, user UPDATE, and stash-drain all commit together — without the optional parameter the helpers would auto-acquire a separate connection and break atomicity.

When NOT to pass `tx`: bulk operations that are intentionally separate from the caller's txn (e.g. fire-and-forget audit appends from a sweeper). Default arg = global pool; pass `tx` only when atomicity is load-bearing.

### Adding a new repo

1. New table → new file. Mirror the existing import block (`drizzle-orm` predicates, `../db/schema`, `../utils/database`, `./errors`).
2. **Always** project explicit columns on public read paths — never `select *`. `passwordHash` is the canonical "must never escape" but the rule extends to any future PII column.
3. If the table is per-doc, write tuple-key helpers from day one. Backfilling tuple-key isolation later means auditing every consumer.
4. If the table is append-only (audit, activity, history), don't export `update`/`delete` even if drizzle would let you. Make the API shape match the invariant.
5. Domain errors via `errors.ts`; HTTP-shaping at the endpoint via `toHttpError`.
