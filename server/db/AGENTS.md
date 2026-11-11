# server/db

`schema.ts` is the schema source of truth. How migrations run, plus recipes (pgvector, partial unique indexes, indexes and foreign keys on populated tables, guarded TRUNCATE): `docs/contributing/database.md`.

## Rules

- After editing `schema.ts`, run `bun run db:generate` and commit the SQL file together with its `drizzle/meta/` snapshot. Never edit an applied migration's SQL.
- Enum-like columns are `text('col', { enum: [...] })`, never `pgEnum`: adding a value then needs no migration.
- The boot migrator applies all pending files in ONE transaction. Never write `CREATE INDEX CONCURRENTLY` or anything else that cannot run in a transaction into a migration; for a large table, build the index out of band first (recipe in the contributor doc).
- A `DROP` / `TRUNCATE` fails the `migration-guard` CI job unless the file carries `-- allow-destructive: <reason>`. Give a real reason.
- Never touch the type of `workspace_knowledge_chunks.embedding` in a migration; the column size is set at boot from `NUXT_LITELLM_EMBEDDINGS_DIMS`.
- Choose `onDelete` on purpose: `cascade` for owned children, `set null` for records that must outlive a deleted user (audit, abuse reports). Adding a user-referencing column means checking the account-deletion purge (`server/utils/privacy/accountDeletionExecute.ts`) and the data export (`server/utils/privacy/dataExport.ts`).
- Columns that hold personal data need an entry in the privacy registries (`server/legal/AGENTS.md`).
- `consent_log` and `audit_log` are append-only: no update path (rows leave only through retention sweeps and FK `set null`).
- Never catch the error `resolvePostgresSsl()` throws on an unreadable `PGSSLROOTCERT`; a misconfigured deploy must fail at boot.
