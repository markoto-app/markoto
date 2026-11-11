# server/repos

Drizzle queries, one file per table family. Anything that spans several tables or calls S3 / Valkey / other services lives in `server/utils/<domain>/` and calls the repos.

## Rules

- Extend the file that owns a table; a query that pulls a third table into a join usually belongs in `server/utils/`.
- Per-document lookups by an externally supplied id are keyed on the `(id, docId)` tuple (`getActivityById(activityId, docId)`). A row of doc B requested through doc A's URL returns null. Never take a bare id and trust the URL prefix. Same for other owned resources: key on `(id, owner)`.
- Project explicit columns on every read path that reaches a client. Never `select()` a whole `users` or `documents` row into a response.
- Throw only the domain errors in `errors.ts` (`NotFoundError`, `ConflictError`, `DuplicateError`, `LastAdminError`); endpoints map them with `isRepoError(e)` / `instanceof` and `e.httpStatus`. Never throw an HTTP error from a repo, and never let a `pg` error code leak out.
- Append-only tables (`audit.ts`) export no update or delete helpers; only the retention sweep in `server/utils/privacy/legalRetentionSweep.ts` deletes audit rows.
- Call `useDatabase()` inside each function; never cache the handle at module scope (tests swap the pool). Use `useDatabasePool()` only when you need a `PoolClient`.
- When a repo function may run inside a caller's `db.transaction`, take an optional `db?: DbOrTx` and use it, so the writes commit atomically with the caller (examples: `repos/sso.ts`, `repos/aiCreditGrants.ts`, `utils/billing/stripeWebhook.ts`).
- Raw `tx.execute(sql\`…\`)` returns timestamps as strings; coerce them (see `toDate` in `dataExportJobs.ts`). Typed `select()` does this for you.
- Concurrency-sensitive check-then-write (quotas, seats, caps) runs in one transaction under `pg_advisory_xact_lock(hashtext(key))`, as in `uploads.ts`.
