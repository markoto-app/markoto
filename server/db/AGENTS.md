# server/db

Single source of truth for the schema (`schema.ts`) plus the migration cookbook below. Drizzle generates SQL into `drizzle/` (committed); `server/plugins/00-db-migrate.ts` applies on boot. The `pgvector/pgvector:pg16` image is used in dev/local/test/prod so generated migrations against a stock `postgres:16` will not detect the `vector` extension — see Recipe 1.

## Source-of-truth conventions

- **`pg` driver, single stack-wide.** `y-postgresql` requires `pg.PoolConfig`; mixing drivers = two pools.
- **Text-typed enums, NOT `pgEnum`.** `text('action', { enum: [...] }).notNull()`. Adding a value is TS-only — no `ALTER TYPE` migration needed. Used everywhere (action enums, scopes, plan names, audience labels, statuses). Don't reach for `pgEnum` — adding a value would force a migration with `ALTER TYPE … ADD VALUE` which can't run inside a transaction and complicates rollback.
- **Foreign key strategy:** `onDelete` is set deliberately. `cascade` for owned children (workspace_members → workspaces, knowledge_chunks → knowledge), `set null` for soft history (activity_log.user_id when the user is purged — the row stays, attribution becomes anonymous). `restrict` (the default) is rare; documents.user_id is `set null` so a user's docs survive account deletion as anonymous.
- **Numeric prefixes on plugins** (`00-db-migrate.ts` first, `99-shutdown.ts` last) force load order. The migrate plugin is what runs the SQL on boot, so it must come before any plugin that reads from the DB.
- **`drizzle/` MUST be COPYed into the runtime image** in the Dockerfile or migrations fail to apply on boot.

## Migration cookbook

**Destructive-migration guard:** CI's `migration-guard` job runs `scripts/check-destructive-migrations.ts` over CHANGED `drizzle/*.sql` files and fails on `DROP` / `TRUNCATE` / similar unless the file carries an explicit `-- allow-destructive: <reason>` marker. Intentional destructive migrations must add that comment with a real rationale.

### Recipe 1: Adding a `vector(N)` column or pgvector index

Drizzle does NOT emit `CREATE EXTENSION`. The first migration to touch pgvector must hand-prepend the extension DDL or the next `db:generate` will silently produce SQL that explodes on apply.

**Steps:**
1. `bun run db:generate` after editing `schema.ts`.
2. Open the generated `0xxx_*.sql` file. Insert at the top:

```sql
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
```

3. The `--> statement-breakpoint` token is critical — drizzle's runner splits on this string. Without it the runner sends the whole file as one PG statement and `CREATE EXTENSION` outside a transaction breaks combined execution.
4. **Verify** by running migrations against a clean database (drop dev DB, restart compose) before merging.

**Done already in:** `0005_lame_cassandra_nova.sql` (workspace_knowledge_chunks).

**HNSW dimension cap:** pgvector's HNSW index caps at 2000 dims. We use 768 — Jina v5-text-nano's native dimensionality (no MRL truncation needed) — for HNSW + cost. Larger embedding models (>2000 dims) would require IVFFlat — slower + worse recall.

### Recipe 2: Partial unique indexes

Drizzle 0.45.2 takes `where` (NOT `targetWhere` — that's Drizzle 0.46+). The activity-log dedup index lives at `schema.ts`:

```ts
uniqueIndex('uq_activity_doc_yjsafter')
  .on(table.docId, table.yjsDocIdAfter)
  .where(sql`yjs_doc_id_after IS NOT NULL AND action IN ('edit', 'title.changed', 'theme.changed')`)
```

Three constraints work together:
1. The `WHERE` clause narrows uniqueness so action types that legitimately share `(docId, yjsDocIdAfter)` are excluded (comment.* events that fan out from one snapshot batch; user-originated `restore` rows).
2. The repo INSERT must use `ON CONFLICT DO NOTHING` for the index to absorb a race rather than throw.
3. The conflict target in the INSERT must match the index. Drizzle's `onConflictDoNothing({ target: ... })` with the same column tuple works; `onConflictDoNothing()` with no target also works since it picks the first matching constraint.

**Use this pattern** when you need cross-instance dedup at the DB level (the activity-log race documented in `sync-server/AGENTS.md` is the canonical example).

### Recipe 3: Adding an index to a populated table

Drizzle's generated SQL always emits `CREATE INDEX` (locks the table). For empty tables this is fine. For tables that have been populated in prod (`activity_log`, `workspace_knowledge_chunks`, `yjs_documents`, `audit_log`) you MUST hand-edit the generated SQL **before applying.**

**Steps:**
1. `bun run db:generate`.
2. Open the generated SQL.
3. Replace `CREATE INDEX` with `CREATE INDEX CONCURRENTLY`.
4. **Remove the `BEGIN;` / `COMMIT;` wrapping** — `CONCURRENTLY` cannot run inside a transaction. Drizzle's migration runner wraps each file in a txn by default; you may need to split the index creation into its own file with no other DDL.
5. Add a leading comment in the migration file explaining why it deviates from drizzle's default shape so the next reviewer doesn't "fix" it back.
6. **Test on a populated dev DB** before merging — `CONCURRENTLY` failure modes are different (it returns and leaves an `INVALID` index that needs `DROP INDEX` + retry).

### Recipe 4: Adding a value to a text-enum column

This is the cheap path — that's the whole reason we don't use `pgEnum`.

**Steps:**
1. Edit the `enum: [...]` array in `schema.ts`.
2. `bun run db:generate` — drizzle MAY emit no SQL (text columns don't track CHECK constraints), in which case nothing to apply.
3. Ship the code change. Existing rows are unaffected.

If you DO want a CHECK constraint enforcing the enum at the DB level (we don't today; the TS type is sufficient), add it as a hand-written migration with `ALTER TABLE … ADD CONSTRAINT … CHECK (column IN (...))`. Keep in mind that adding values then requires another migration to extend the CHECK.

### Recipe 5: Adding an FK without breaking concurrent writers

`ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` takes a SHARE ROW EXCLUSIVE lock and validates every existing row. On a large table this can block writes for minutes.

**Steps for a populated table:**
1. Generate the migration normally.
2. Hand-edit to split into two statements:

```sql
ALTER TABLE child ADD CONSTRAINT fk_child_parent
  FOREIGN KEY (parent_id) REFERENCES parent(id) NOT VALID;
--> statement-breakpoint
ALTER TABLE child VALIDATE CONSTRAINT fk_child_parent;
```

3. The `NOT VALID` form skips the existing-rows check (instant, takes a SHARE UPDATE EXCLUSIVE lock). `VALIDATE CONSTRAINT` then scans without blocking writes.

We haven't needed this yet — most FKs were added at table-create time — but document it here so the next time we add one to a populated table the recipe is on hand.

### Recipe 6: TRUNCATE in a migration

`yjs_documents` is created lazily by y-postgresql at sync-server startup, NOT by drizzle. Migrations that TRUNCATE optional tables need `IF EXISTS` guards:

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'yjs_documents') THEN
    TRUNCATE yjs_documents;
  END IF;
END $$;
```

Don't TRUNCATE in migrations unless you genuinely need to — almost always a fresh table can be `DROP TABLE IF EXISTS` + recreate, which is cleaner.

## Slow-query log

`useDatabase()` in `server/utils/database.ts` wraps `pool.query` with a timing probe. Queries past `NUXT_DB_SLOW_QUERY_MS` (default 200ms) fire a warning-level Sentry event tagged `component=db, event=slow_query`. SQL is truncated to 500 chars; **param VALUES are NEVER logged** (PII / secrets risk) — only `paramsCount`. Override the threshold per-environment for noisier dev or tighter prod alerting.

## Privacy / compliance tables

Three tables back the privacy infrastructure (Workstream B). All follow the existing conventions but have load-bearing FK + retention shapes worth noting:

- **`consent_log`** — append-only ePrivacy/GDPR-Art.7 record. Keyed on `anonId` (the `markoto-anon-id` cookie, persists past login) plus optional `userId` for the post-login bridge. There is NO unique constraint — every save writes a new row; "current consent" is whatever the latest row by `received_at` says. Don't add an UPDATE path.
- **`abuse_reports`** — DSA Art.16 queue. `reporter_user_id` is `ON DELETE SET NULL` so reporter deletion doesn't drop the record (snapshotted `reporter_email` survives for moderator follow-up). `doc_id` is plain `text`, NOT an FK to `documents.doc_id` — moderators triage by URL, malformed/missing ids are informational. Migration `0013_*.sql` dropped the original FK after a "test" input pasted by a real reporter exploded with FK violation.
- **`data_export_jobs`** — GDPR Art.15/20 worker queue. Status lifecycle `queued` → `running` → `ready` (+ `s3_key` + `expires_at`) / `failed` (+ `error_message`) / `expired`. Drained by the `data-export-worker` plugin; expired rows reaped by `data-export-expiry-sweep`.

**Account-deletion columns on `users`** (`deletion_requested_at`, `deletion_grace_until`) are nullable — null on both is the steady state. Cancellation = `UPDATE … SET deletion_requested_at = NULL, deletion_grace_until = NULL`. The sweep scans for `deletion_grace_until < now()` (partial index). Hard purge in `accountDeletionExecute.ts` deletes the row entirely, taking owned docs + sole-member workspaces with it.

**Policy-acceptance columns on `users`** are paired: `*_version_accepted` (integer) + `*_locale` (text) for privacy / tos / dpa, plus `age_confirmed_at` (timestamp). Bumping a `_VERSION` constant in `shared/legal/versions.ts` makes every user with a stale `_version_accepted` re-prompt — no migration touches the table.

**`audit_log.actor_ip` is /24 (IPv4) or /48 (IPv6) truncated** at write time via `truncateIp` from `server/repos/audit.ts`. The repo trusts what it gets — call sites ALWAYS pass through the helper. Same pattern in `abuse_reports.reporter_ip_truncated`.

**`actor_user_id` / `reporter_user_id` are `ON DELETE SET NULL`** — purging a user nulls the FK on their audit + abuse-report attribution but the row survives so historical queries make sense ("user [now-deleted] reported X on date Y").

## SSL

Production uses OVH-managed Postgres which requires TLS. `server/utils/database.ts` calls `resolvePostgresSsl()` which reads `PGSSL` (only honoured value: `disable`, an explicit opt-out) and `PGSSLROOTCERT`, and **fails loudly** on an unreadable `PGSSLROOTCERT` path — silent fallback to no-TLS would expose credentials over the public network. Don't catch the throw; let it propagate so a misconfigured deploy fails at boot.
