# Database schema and migrations

markoto keeps all application data in PostgreSQL. The schema is defined with Drizzle in `server/db/schema/`, one file per domain (users, workspaces, documents, sync, collab, brand kit, billing, ai, knowledge, privacy, sso, publish, mcp) re-exported from `server/db/schema/index.ts`, which is what drizzle-kit reads and what `server/db/schema` imports resolve to. Domain files import each other's tables only downwards (a table's file imports the files of the tables it references), never in a cycle; `drizzle-kit` generates SQL migrations into `drizzle/` (committed together with the snapshots in `drizzle/meta/`). Agent rules for this area: `server/db/AGENTS.md`.

## How migrations run

- `drizzle/0000_baseline.sql` creates the whole schema in one file. The migration history before it was squashed away; a database created by an earlier version cannot be upgraded across that and has to be recreated (the boot migrator fails with `relation "…" already exists`).
- `bun run db:generate` diffs the schema against the latest snapshot and writes `drizzle/NNNN_<name>.sql`.
- At boot, `server/plugins/00-db-migrate.ts` applies pending files with `drizzle-orm/node-postgres/migrator`. Drizzle runs **all pending files in one transaction**. If a migration fails, the process exits.
- Startup work that needs the migrated schema waits on `migrationsComplete` (`server/utils/platform/migrations.ts`).
- The runtime image copies `drizzle/` (see `Dockerfile`); without it nothing can be applied.
- `yjs_updates` (document Y.js state) is in the schema like every other table; the sync server only reads and writes it. Layout and invariants: [sync-server.md](sync-server.md#persistence).
- The knowledge embedding column is `vector(768)` in the schema and is retyped at boot to the configured size (`server/plugins/02-embeddings-dimension.ts`). Never generate a migration that changes it; see [knowledge-base.md](knowledge-base.md).

## CI guard for destructive migrations

The `migration-guard` CI job runs `scripts/check-destructive-migrations.ts` (locally: `bun run db:check-migrations`) over changed `drizzle/*.sql` files. It fails on `DROP`, `TRUNCATE` and similar statements unless the file carries a comment of the form:

```sql
-- allow-destructive: <reason>
```

## Recipes

### Enum-like columns

Columns with a fixed set of values are `text('col', { enum: [...] })`, not `pgEnum`. Adding a value is a TypeScript change; `db:generate` emits no SQL for it. If you ever add a database `CHECK` for such a column, every later value needs a migration too.

### pgvector

Drizzle does not emit `CREATE EXTENSION`. The extension is created by a hand-written statement at the top of `drizzle/0000_baseline.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
```

A migration that needs another extension does the same. The `--> statement-breakpoint` marker is how the migrator splits a file into statements. Dev, local and test stacks use the `pgvector/pgvector` Postgres 18 image, which ships the extension.

### Partial unique index for cross-instance deduplication

Two sync-server instances can report the same edit batch. The activity log absorbs that with a partial unique index (`uq_activity_doc_yjsafter` in `server/db/schema/collab.ts`):

```ts
uniqueIndex('uq_activity_doc_yjsafter')
  .on(table.docId, table.yjsDocIdAfter)
  .where(sql`yjs_doc_id_after IS NOT NULL AND action IN ('edit', 'title.changed', 'theme.changed')`)
```

The insert uses `onConflictDoNothing` so the second writer is a no-op instead of an error. With Drizzle 0.45 the predicate option of `onConflictDoNothing` is named `where`.

### Indexes on populated tables

`CREATE INDEX` blocks writes to the table while it builds. That is fine for new or small tables. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and the boot migrator wraps every pending file in one, so it cannot be used in a regular migration. For a large table, build the index out of band with `CONCURRENTLY` before the release and make the migration `CREATE INDEX IF NOT EXISTS`. Leave a comment in the migration explaining the choice (table size, expected lock time).

### Foreign key on a populated table

`ADD CONSTRAINT … FOREIGN KEY` validates every row under a lock that blocks writes. Split it:

```sql
ALTER TABLE child ADD CONSTRAINT fk_child_parent
  FOREIGN KEY (parent_id) REFERENCES parent(id) NOT VALID;
--> statement-breakpoint
ALTER TABLE child VALIDATE CONSTRAINT fk_child_parent;
```

`VALIDATE CONSTRAINT` scans without blocking writes.

## Foreign keys and personal data

`onDelete` is chosen per relation:

- `cascade` for children owned by their parent (workspace members, knowledge chunks).
- `set null` where the record must outlive the person: `audit_log.actor_user_id`, `abuse_reports.reporter_user_id`. The row stays; attribution becomes anonymous.
- `documents.owner_id` has no `onDelete`: account deletion removes the user's documents before it deletes the user row (`server/utils/privacy/accountDeletionExecute.ts`).
- `abuse_reports.doc_id` is free text, not a foreign key: reporters paste arbitrary input.

`consent_log` is append-only and keyed on the `markoto-anon` cookie id; the current state for an id is its newest row.

## Who may query

Only `server/repos/**` talks to the database; everything else calls a repo function (dependency-cruiser rule `db-access-only-in-repos`, ESLint `markoto/data-access-boundaries`). `server/db/` holds the schema, the connection (`client.ts`), the boot migrator (`migrate.ts`), the LiteLLM spend-log pool (`litellm.ts`, the only second pool) and the embedding-column maintenance used by `bun run knowledge:reembed`. Raw SQL is written with Drizzle's `sql` template, so every value is a bound parameter.

Repo functions that write or return tenant-private data take a capability proof instead of a bare id; see `server/repos/AGENTS.md` and `docs/SECURITY-HARDENING.md` → Tenancy.

### Transactions

There is one mechanism. Code outside the repos that needs several repo writes to commit together calls `withTransaction(async (tx) => …)` (`server/repos/transaction.ts`) and passes `tx`, an opaque `TxHandle`, useless for building a query, as the last argument of each repo call. Inside a repo, `executor(tx)` returns the caller's transaction or the pool; a repo that opens its own `db.transaction` passes it on to other repos with `asTxHandle(tx)`. The Stripe webhook dispatcher (`server/utils/billing/stripeWebhook.ts`) and the restore flow (`server/utils/documents/restoreDoc.ts`) are the main users.

## Connection and TLS

`useDatabase()` (`server/db/client.ts`) returns the Drizzle handle over a `pg` pool; `pg` is the only Postgres driver in the stack, the sync server included. TLS settings come from `resolvePostgresSsl()` (`shared/utils/runtime/postgresSsl.ts`): `PGSSL=disable` opts out, `PGSSLROOTCERT` pins a CA and an unreadable path fails the boot. Queries slower than `NUXT_DB_SLOW_QUERY_MS` (default 200) are reported to Sentry with the SQL truncated and without parameter values.
