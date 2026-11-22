# Sync server

The sync server (`sync-server/`) is a standalone Hocuspocus process that holds the live Y.js documents, persists them to Postgres and writes the activity log. It runs in its own container because long-lived WebSockets and in-memory `Y.Doc`s should not share the Nuxt event loop. Agent rules for this folder are in [`sync-server/AGENTS.md`](../../sync-server/AGENTS.md).

Entry point: `sync-server/src/index.ts`. It runs as TypeScript directly under Bun (`bun run src/index.ts`, see `sync-server/Dockerfile`); there is no bundle step.

## Persistence

A document's Y.js state is an append-only log in the `yjs_updates` table, declared in `server/db/schema/sync.ts` and created by the app's migration like every other table (the sync server never runs DDL). Each row belongs to a `documents` row (`ON DELETE CASCADE`).

| Column | Meaning |
|---|---|
| `id` | `bigint` identity. Within one document, id order is commit order (see locking below). Activity rows store these ids. |
| `kind` | `update`: a Y.js update. `snapshot`: the merged state of every row of the document with a smaller id. |
| `data` | The Y.js update bytes. |
| `created_at` | Used by pruning. |

**State at an id.** The state at id X is every row with id ≤ X applied, which equals the newest snapshot ≤ X plus the updates after it. Loading is the same rule at the newest id. Snapshots hold no information of their own, so writing one never changes any state.

**Code.** The SQL on `yjs_updates` is in `sync-server/src/yjs-store.ts`. After each store `sync-server/src/search-index.ts` also writes the document's row in `document_search` (and touches `documents`) for the explorer's search, see [explorer](explorer.md); `compaction.ts` takes the sweep lock. `sync-server/src/persistence.ts` is the Hocuspocus side; `persistence-instance.ts` wires both to the env. The app reads and writes the table only through `server/repos/yjsLog.ts`. The two modules share the lock namespace `YJS_LOCK_NAMESPACE` (pinned equal by `tests/repos/yjsPersistence.test.ts`).

**Load.** `onLoadDocument` reads the newest snapshot plus the updates after it in one statement and returns the document. A database error is re-thrown, so Hocuspocus refuses the connection and the client retries; it must never answer with an empty `Y.Doc`, because connected clients would then present their state as new. A row that cannot be decoded is skipped and reported to Sentry (it stays in the table).

**Store.** Hocuspocus debounces stores (`debounce: 2000`, `maxDebounce: 10000`). A store appends `Y.encodeStateAsUpdate(document, persistedStateVector)`: the delta since what this process last persisted, plus the full delete set (deletions do not move the state vector). The state vector is taken at load and advanced only after the append committed:

- A store is one transaction (`BEGIN`, lock, read the newest id, `INSERT`, `COMMIT`). When it resolves, the row is durable; when it fails, nothing was written and the next store's delta still contains everything.
- Two instances holding the same document each append their own deltas. Y.js updates commute and are idempotent, so both are kept and merge on load.
- The id read under the lock is the document's state before this store. It becomes the activity row's `yjsDocIdBefore`; the inserted id becomes `yjsDocIdAfter`.
- A failed store is retried three times (0.25 s, 1 s, 3 s). If it still fails, the document is marked unsaved: `beforeUnloadDocument` refuses to unload it (its edits exist only in memory) and a 15 s timer retries until the store succeeds. On shutdown the veto is lifted after one last try; the document ids that are still unsaved are logged as errors (clients that hold the edits send them again on reconnect).
- A store for a document whose `documents` row is gone fails on the foreign key: the edits are dropped on purpose (the document was deleted) and logged at info level.
- A row above `SYNC_MAX_DOCUMENT_BYTES + SYNC_MAX_UPDATE_BYTES` is refused before it reaches Postgres. The update guard keeps documents below that, so this only fires on a guard bypass.

**Locking.** Every write (store, snapshot, prune, and the app's first row of a new or duplicated document) holds `pg_advisory_xact_lock(YJS_LOCK_NAMESPACE, hashtext(doc_id))` until it commits. Writers of the same document wait for each other (a store is a few milliseconds); writers of different documents never do. Without the lock a row with a smaller id could commit after a larger one was read, and a snapshot could miss it.

**Snapshots (compaction).** The persistence counts the updates of each open document since its newest snapshot (at load, then per store). Above `COMPACT_THRESHOLD` (default 500) the document is queued, and the periodic sweep (`sync-server/src/compaction.ts`, every `COMPACT_INTERVAL_MS`, default 900000, `<= 0` = off) writes a snapshot for up to `COMPACT_MAX_DOCS_PER_RUN` (default 50) queued documents. A snapshot reads and merges the log without the lock, then under the lock applies the rows appended meanwhile and inserts the snapshot, whose new id is above every row it covers. If another instance snapshotted meanwhile, it writes nothing. The snapshot is decoded again and compared with the merged document before it is inserted, and a document with an unreadable row is never snapshotted. A session advisory lock keeps instances from sweeping at the same moment; the per-document lock makes concurrent work safe anyway. Snapshots delete nothing: every id stays replayable.

**Pruning (history retention).** Only with `COMPACT_RETAIN_HISTORY_DAYS` > 0 (default 0 = keep all history). For a document with a snapshot older than the window, the sweep deletes every row below the newest such snapshot. That snapshot becomes the document's oldest row, the **history floor**: ids from it on replay exactly; older ids raise `YjsHistoryCompactedError`, which restore maps to 410 (error code `restore-compacted` in the `docs` error namespace) and the diff to 410 (`diff-unavailable` (same namespace)). Every activity row created inside the window refers only to ids at or above the floor (an id is the newest row at the moment it was recorded, and the kept snapshot existed then), so set the retention at least as long as the longest plan history window (`TIER_*_HISTORY_DAYS`). A document whose oldest row is an `update` was never pruned: an id below it is the empty state before its first write.

**Deletion.** Deleting the `documents` row deletes its Y.js rows in the same statement, whether the delete comes from the user, a workspace, the account-deletion purge, moderation or the inactive-document sweep. `POST /internal/notify-deleted` only tells connected clients and unloads the document; a later store of it is refused by the foreign key, so a deleted document cannot come back.

**Observability.** Loads and stores are logged at debug level with `durationMs` and `bytes`, at warn level above one second. After every sweep a `persistence stats` line sums loads, stores, bytes, average and maximum store time, failures and unsaved documents. Sentry tags: `component: persistence` with `event` `load_failed`, `store_failed`, `store_refused`, `unreadable_rows`; `component: compaction` with `snapshot_failed`, `prune_failed`, `sweep_failed`.

`POST /internal/flush-document` runs a pending store immediately; the app calls it before reading a live document's rows (duplicate, render).

## Authentication and authorization

- Every connection must present a doc JWT with an `exp`, and `payload.docId` must equal the document name (`sync-server/src/auth.ts`). `JWT_SECRET` is required at startup.
- **Connections end with their authorization** (`sync-server/src/connection-expiry.ts`). The `connected` hook tracks each connection with its token expiry. 45 s before expiry the server sends a Hocuspocus token request; the editor fetches a fresh token from `/api/docs/:docId/token` and `onTokenSync` verifies it with the same rules as the handshake. If no valid renewal arrives by expiry plus 5 s, the connection is closed with code 4419 and reason `reauthenticate` (`shared/contracts/syncClose.ts`). A renewal that changes the principal or the read-only flag also closes the connection, so the new access applies through a normal reconnect. A connection without a token expiry is closed at once.
- **Access that becomes stricter** (access mode, password, share expiry or view-only, moderation, workspace move) makes the app call `POST /internal/reauth-document` (`notifySyncReauthDocument` in `server/utils/documents/syncNotify.ts`). The sync server stores a not-before cutoff in Valkey (`sync:not-before:{docId}`, 3 h TTL, `sync-server/src/doc-not-before.ts`) and closes every connection of that document except the app's own server-side clients (AI, MCP, restore). Tokens issued before the cutoff no longer open the document on any instance. A Valkey failure fails open; the token's own expiry still bounds access.
- `POST /internal/kick-user` closes a user's connections on the given documents (membership changes) with the same re-authenticate close.
- On the client, `app/composables/document/useHocuspocusSync.ts` passes a token accessor to the provider and treats the `reauthenticate` close as "refetch the token, then reconnect". When the token endpoint issues no token any more, the editor shows the no-access or password screen. The app's server-side clients (AI loop, MCP) pass a token-minting function to `server/utils/mcp/yDocPool.ts` so they renew too.

## Internal HTTP

`sync-server/src/internal-http.ts` serves `/internal/*` for the app. Requests must carry the internal secret (`X-Internal-Secret`, constant-time check, previous secret accepted during rotation), and requests that carry the edge proxy's forwarding headers get 404: these routes are reachable only on the internal network. `GET /health` is public and handled in `index.ts`.

| Route | Purpose |
|---|---|
| `POST /internal/notify-deleted` | Set `ymeta._deleted`, then unload the document (its rows went with the `documents` row) |
| `POST /internal/kick-user` | Close a user's connections on given documents |
| `POST /internal/reauth-document` | Store a not-before cutoff and close the document's connections |
| `POST /internal/flush-document` | Run the debounced store now and wait for it |

## Limits and guards

- **Rate limiter** (`sync-server/src/rate-limiter.ts`): connections per IP (`SYNC_MAX_CONNECTIONS_PER_IP`, default 20 in production, 200 otherwise) at most `SYNC_MAX_ROOMS` loaded rooms (10000; joining a document that is already loaded is never refused by the room cap) and, through the memory guard, no new room while the process's resident memory is above `SYNC_MEMORY_GUARD_PERCENT` (85) of the container limit (`sync-server/src/room-capacity.ts`, limit from the cgroup or `SYNC_MEMORY_LIMIT_BYTES`). All refuse with the reason `server-busy`; the editor shows "busy, retrying" and reconnects with backoff. Slots are released on every raw socket close, including failed handshakes, because Hocuspocus only calls `onDisconnect` for authenticated connections.
- **Grace rooms** (`sync-server/src/room-capacity.ts`): a document stays loaded for `SYNC_UNLOAD_GRACE_MS` (30 s) after its last connection closed, so a reload or a quick switch back skips Postgres. The store is not delayed: Hocuspocus stores pending edits when the last connection closes and only then tries to unload; `beforeUnloadDocument` vetoes that first attempt (`GraceHold`) and the grace timer retries it. A connection that arrives in time cancels the grace. Before the room cap or the memory guard refuses a new document, `makeRoom` unloads grace rooms, oldest first (all of them under memory pressure). Deleted documents (`notify-deleted`) and shutdown skip the grace.
- **Hidden tabs** (`app/utils/collab/hiddenTabPause.ts`): the editor disconnects after its tab has been hidden for `NUXT_PUBLIC_SYNC_HIDDEN_DISCONNECT_MS` (4 min, below the 5 min after which Chrome throttles background timers to once a minute and the 15 s awareness renewal would make the user flicker for others), only once the server acknowledged every local change, and reconnects with the same provider when shown. Meanwhile its awareness state carries `away: true`.
- **Update guard** (`sync-server/src/update-guard.ts`, `beforeHandleMessage`): checks each message before Hocuspocus applies it. Size caps from `sync-server/src/limits.ts`: `SYNC_MAX_MESSAGE_BYTES` (17 MiB, also the WebSocket `maxPayload`), `SYNC_MAX_UPDATE_BYTES` (16 MiB), `SYNC_MAX_DOCUMENT_BYTES` (16 MiB; pure deletions always pass so an oversized document can be trimmed). Every write to the `meta` map must pass `shared/utils/documents/ymetaValidation.ts`, the same contract as `PUT /api/docs/:docId/meta`; nested Y types inside `meta` are refused. An item that references state the server doesn't have yet (edits queued by a client across a sync-server restart) is accepted and parked by Y.js; it is checked in the update that makes it placeable, and an invalid parked item drops the parked set instead of closing the connection that completed it. Read-only connections may not send stateless frames, which Hocuspocus would relay to every editor. Every write to the `suggestions` map must be one valid record stored under its id (`shared/utils/suggestions/record.ts`). A suggest-only connection (JWT `suggestOnly`, issued where the document requires suggestions of that person or lets viewers suggest) may write only its own suggestions and the `comments` array: text, `meta` and other people's suggestions are refused (`invalid-suggestion`), deletions included, and its items must be placeable at once. A rejection closes the document connection with a reason from `shared/contracts/syncClose.ts`; the editor resyncs with a fresh connection a few times on `invalid-update`, and otherwise (or when that keeps failing) shows a "changes were not saved" banner and stops reconnecting. Unexpected guard errors fail closed.
- **Pre-auth guard** (`sync-server/src/pre-auth-guard.ts`): Hocuspocus queues messages until a document has authenticated. The guard caps that queue per socket (`SYNC_MAX_PREAUTH_BYTES`, 32 MiB) and across all sockets (`SYNC_MAX_PREAUTH_TOTAL_BYTES`, 256 MiB) and closes sockets that queue frames without authenticating within `SYNC_AUTH_TIMEOUT_MS` (15 s).
- **Awareness** (`sync-server/src/awareness-guard.ts`): every client's awareness `user` field is normalised with `shared/utils/documents/awarenessUser.ts` before it is relayed. There is no avatar URL field; anonymous visitors broadcast a random avatar seed.
- **Corrupted documents stay loadable**: `readMetaSnapshot` (`sync-server/src/meta-snapshot.ts`) never throws; an unreadable theme hashes to a fixed value, so a valid theme can be written over it.

## Activity logging

On every store the server compares the text and the `meta` snapshot with the previous state and posts `edit`, `title.changed` and `theme.changed` rows to the app (`POST /api/internal/activity`, fire-and-forget, 5 s timeout). Each row carries `yjsDocIdBefore` / `yjsDocIdAfter`, the `yjs_updates` ids around the store (see [Persistence](#persistence)), so the Activity Log can show diffs and restore (see [activity-log.md](activity-log.md)). Comment changes are mirrored with `POST /api/internal/comments-snapshot`.

Attribution comes from the editing connection's JWT, never from the client-chosen awareness name. The last editor is recorded in `onChange`; if that record is missing (cold document, Valkey down), the fallback is the JWT identity of the writer connection whose awareness changed last. Anonymous editors are logged as "Anonymous" with the avatar seed their connection broadcast.

Per-document state lives in Valkey (`sync-server/src/sync-state.ts`) so several sync instances can share it, each key with a 24 h TTL. Valkey runs with `maxmemory-policy noeviction`: these keys share it with rate-limit counters, locks and token cutoffs, which an eviction policy could drop to make room (every key has a TTL, so `volatile-lru` would not protect them either). The diff baseline is therefore a bounded line digest, not the text:

| Key | Content |
|---|---|
| `sync:last-editor:{docId}` | JWT identity of the last editor |
| `sync:prev-lines:{docId}` | Line digest at the last store (diff baseline): 8 characters per line, only the line count above 2000 lines (`lineDigest` in `activity-logger.ts`) |
| `sync:prev-meta:{docId}` | Title + theme hash at the last store |

The sync server deletes them when it unloads the document (`afterUnloadDocument`, after the final store), and the app deletes them when it deletes the document (`server/utils/documents/documentLifecycle.ts`; key names in `shared/contracts/syncState.ts`). Renders never open a document on the sync server (the print page replays the stored log), so they leave no state.

Valkey errors never block sync: a missing baseline skips that edit row, a missing editor uses the fallback.

## Multiple instances

Hocuspocus keeps each loaded document in one process, so production routes WebSocket clients with a sticky cookie at Traefik (`deploy/compose/compose.prod.yml`). Two instances can still store the same document at the same time; the partial unique index `uq_activity_doc_yjsafter` on `activity_log` drops the duplicate `edit` / `title.changed` / `theme.changed` row (`server/api/internal/activity.post.ts` logs `[activity] dedup skipped insert`). When two instances read the same `prev-lines` baseline, the surviving row's line counts can be slightly off. That is accepted: the counts are a summary, and a lock around every store would make writes depend on Valkey.

## Shutdown

SIGTERM stops the compaction sweeper, retries unsaved documents once, unloads the grace rooms, calls `server.destroy()` (drains connections and pending stores), closes the Postgres pool and Valkey. A 25 s timer forces exit; compose gives the container 30 s.

## Tests

- Unit tests run from the root workspace and import `sync-server/src/*` directly: `tests/unit/sync/`. Tests that build `Y.Doc`s for sync-server helpers import Y from `sync-server/src/yjs.ts`, because Y.js relies on `instanceof` and the sync server has its own copy of the package.
- Persistence against the real test Postgres (store, load, failures, two instances, snapshots, pruning, restore semantics): `tests/repos/yjsPersistence.test.ts`.
- Integration tests against the real sync container: `tests/integration/sync/` (for example `persistence.test.ts`, `syncHardening.test.ts` and `connectionRevocation.test.ts`). `deploy/compose/compose.test.yml` sets low `SYNC_MAX_*` / `SYNC_AUTH_TIMEOUT_MS` values that must match the constants in `syncHardening.test.ts`.
