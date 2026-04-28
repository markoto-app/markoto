# Server-side Conventions

Nitro API + sync notification layer for md-online. Most cross-cutting code in this directory is organized as:

- `api/` — REST + WS routes (see `api/AGENTS.md` for the route map).
- `routes/` — top-level Nitro routes (e.g. `auth/` for OAuth, the `api/ai/dictate.ts` WS handler).
- `db/schema.ts` — Drizzle source of truth.
- `middleware/auth.ts` — central auth guard with whitelist patterns for public endpoints.
- `plugins/` — Nitro lifecycle hooks (db migrate, shutdown, sweepers).
- `repos/` — Drizzle-backed repositories.
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
- **Central helpers:** `server/utils/workspaceAccess.ts` — `getWorkspaceRole`, `getDocAuthz`, `canEditDoc`, `canManageDoc`, `canManageWorkspace`, `countWorkspaceAdmins`. Additive: standalone/anonymous doc flows unchanged.
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

---

## Auth-middleware conventions

`server/middleware/auth.ts` whitelists public patterns; protects `/api/docs/` (outside whitelist), `/api/workspaces`, `/api/user`, `/api/upload`, `/api/ai`. Token endpoint never issues a usable JWT for forbidden/password-gated docs.

- Use `[^/]+` not `\d+` in whitelist regexes so a malformed id hits 400, not 401.
- New activity-log endpoints (`/diff`, `/comment-context`) are whitelisted because anonymous editors on open-edit docs need them; auth gating happens INSIDE the handlers via `decideActivityAccess`.
- `/restore` is deliberately NOT whitelisted — falls through to the protected branch.

---

## Repos

`server/repos/` exports table-bounded query helpers. Conventions:

- **Never ship `passwordHash`.** Always project explicitly on public endpoints.
- **Cross-doc isolation via tuple keys.** `getActivityById(activityId, docId)` is keyed on the (id, docId) tuple — a row from doc B accessed via doc A's URL returns null. Same pattern across `/diff`, `/comment-context`, `/restore`. Closes the timing-oracle for "does activityId X exist on doc Y?".

---

## Sweepers / plugins

`server/plugins/` runs at boot. Naming uses numeric prefixes for load order (`00-db-migrate.ts` before `99-shutdown.ts`). Background sweepers:

- `orphan-cleanup` — removes pending uploads with no DB row.
- `ai-session-sweep` — aborts AI sessions older than 7 min (above the 5-min prompt deadline).
- `inactive-doc-sweep` — flags stale anonymous docs.
- `knowledge-sweep` — retries stuck-processing rows (10 min TTL) + reaps `failed` rows (7 day TTL).

---

## Other server-side gotchas

- **`nitro.preset: 'bun'`** — `node-server` preset traces wrong condition for packages with Bun conditional exports (lib0).
- **Nitro NFT tracer misses `@google/genai`'s transitive `ws`** — fix with `nitro.externals.traceInclude: ['node_modules/ws/index.js']`.
- **Nitro WS requires `nitro.experimental.websocket: true`.** Without it, `defineEventHandler({ websocket })` silently ignores hooks.
- **crossws upgrade hook must RETURN void**, not `{ context }`. Returning a non-ResponseInit object corrupts the handshake (ECONNRESET, worker crash). Mutate `request.context` in-place instead.
- **Migrations that TRUNCATE optional tables need `IF EXISTS` guards.** `yjs_documents` is created lazily by y-postgresql at sync-server startup, NOT by drizzle. Wrap TRUNCATEs in `DO $$ ... IF EXISTS (SELECT 1 FROM pg_class WHERE relname = '...') THEN ... END IF; ... END $$`.
