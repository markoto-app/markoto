# server/repos

The only code that talks to the database: Drizzle queries and parameterised raw SQL, one file per table family. Anything that spans several tables or calls S3 / Valkey / other services lives in `server/utils/<domain>/` and calls the repos. The layering is api / routes / plugins / mcp → utils → repos → `server/db/`; dependency-cruiser (`db-access-only-in-repos`) and ESLint (`markoto/data-access-boundaries`) refuse `drizzle-orm`, `pg` or `server/db/**` anywhere else. How proofs work and what they guarantee: `docs/SECURITY-HARDENING.md` → Tenancy.

## Proofs

- A function that writes, deletes or returns tenant-private data takes a proof as its first parameter (`DocAccess<level>`, `WorkspaceAccess<level>`, `UserScope`, `AdminActor`, `SystemActor`; types from `./proofs`) and takes the object id FROM the proof (`doc.docId`, `ws.workspaceId`, `self.userId`). Never add a parallel `docId` / `userId` parameter for the same object.
- Ask for the weakest level that is enough (`DocAccess<'view'>` for a read, `'write'` for content, `'manage'` for sharing, `'delete'` for removal). Implied levels are encoded in the type: a manage proof satisfies a view parameter.
- Sub-resources (activity rows, comments, uploads, shares, knowledge files, brand assets, invites, templates, members) are addressed by their own id but constrained to the parent in the proof: `WHERE id = $id AND doc_id = ${doc.docId}`. A row of another document or workspace returns null / not found. Pinned by `tests/repos/tenancyIsolation.test.ts`.
- Instance-wide reads and writes (sweepers, webhooks, the data export) take `SystemActor` / `AdminActor`, even when the parameter is unused (`_by`): the caller must say who it is.
- `access/` holds the bootstrap reads authorization is decided FROM (role lookup, doc ACL row, PAT hash). They take bare ids by design and are importable only from `server/utils/access/**` and `server/utils/mcp/mcpAuth.ts`.
- Never import `./proofs/mint` (access layer only) or `./proofs/testing` (tests only), and never cast to a proof type (`tests/unit/access/proofCasts.test.ts`).
- The audit actor comes from the proof: `appendAuditEvent({ by: proof, … })`.

## Rules

- Extend the file that owns a table; a query that pulls a third table into a join usually belongs in `server/utils/`.
- Project explicit columns on every read path that reaches a client. Never `select()` a whole `users` or `documents` row into a response.
- Raw SQL only through Drizzle's `sql` template (values become parameters). Never build SQL by string concatenation.
- Throw only the domain errors in `errors.ts` (`NotFoundError`, `ConflictError`, `DuplicateError`, `LastAdminError`); endpoints map them with `isRepoError(e)` / `instanceof` and `e.httpStatus`. Never throw an HTTP error from a repo, and never let a `pg` error code leak out.
- Append-only tables (`audit.ts`) export no update helpers; only the retention sweep deletes audit rows (`deleteAuditEventsBefore`).
- Call `useDatabase()` inside each function; never cache the handle at module scope (tests swap the pool). Use `useDatabasePool()` only when you need a `PoolClient`. LiteLLM's database has one pool, owned by `server/db/litellm.ts` and used only by `litellmSpend.ts`.
- Transactions: callers outside the repos use `withTransaction(fn)` (`./transaction.ts`) and pass the opaque `TxHandle` it gives them to each repo call (an optional last parameter `tx?: TxHandle`). Inside a repo, run statements on `executor(tx)`; a repo that opens its own `db.transaction` hands it on with `asTxHandle(tx)`. That is the one mechanism for multi-repo atomic writes.
- Raw `tx.execute(sql\`…\`)` returns timestamps as strings; coerce them (see `toDate` in `dataExportJobs.ts`). Typed `select()` does this for you.
- Concurrency-sensitive check-then-write (quotas, seats, caps) runs in one transaction under `pg_advisory_xact_lock(hashtext(key))`, as in `uploads.ts`.
