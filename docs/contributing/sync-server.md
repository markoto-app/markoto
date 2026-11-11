# Sync server

The sync server (`sync-server/`) is a standalone Hocuspocus process that holds the live Y.js documents, persists them to Postgres and writes the activity log. It runs in its own container because long-lived WebSockets and in-memory `Y.Doc`s should not share the Nuxt event loop. Agent rules for this folder are in [`sync-server/AGENTS.md`](../../sync-server/AGENTS.md).

Entry point: `sync-server/src/index.ts`. It runs as TypeScript directly under Bun (`bun run src/index.ts`, see `sync-server/Dockerfile`); there is no bundle step.

## Persistence

- `sync-server/src/persistence.ts` wraps `y-postgresql` (`yjs_documents` table) with `useIndex: false`, because y-postgresql 1.0.1 has a bug in its index-creation branch. The module creates `idx_yjs_documents_docname` itself at boot (`CREATE INDEX CONCURRENTLY IF NOT EXISTS`).
- Every store appends a row. y-postgresql merges rows only when a document is loaded, so a document that stays loaded keeps growing. `sync-server/src/compaction.ts` runs a periodic sweep that merges the rows of documents above `COMPACT_THRESHOLD` (default 500). It snapshots `MAX(id)` first, merges and deletes only rows up to that ceiling in one transaction, so a concurrent append is never lost. A Postgres advisory lock lets only one instance sweep at a time. Settings: `COMPACT_THRESHOLD`, `COMPACT_INTERVAL_MS` (default 900000; `<= 0` disables), `COMPACT_MAX_DOCS_PER_RUN` (default 50). Compaction raises the lowest row id, so older activity-log restore points become unavailable; the restore code checks for that.
- `onLoadDocument` re-throws a load error so the connection is refused and the client retries. It must never return an empty `Y.Doc` on error: connected clients would then write their cached state back as new content.
- Hocuspocus debounces stores (`debounce: 2000`, `maxDebounce: 10000`). `POST /internal/flush-document` runs a pending store immediately; the app calls it before duplicating a document.

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
| `POST /internal/notify-deleted` | Set `ymeta._deleted`, then unload the document and clear its rows |
| `POST /internal/kick-user` | Close a user's connections on given documents |
| `POST /internal/reauth-document` | Store a not-before cutoff and close the document's connections |
| `POST /internal/flush-document` | Run the debounced store now and wait for it |

## Limits and guards

- **Rate limiter** (`sync-server/src/rate-limiter.ts`): connections per IP (`SYNC_MAX_CONNECTIONS_PER_IP`, default 20 in production, 200 otherwise) and at most 5000 loaded rooms. Slots are released on every raw socket close, including failed handshakes, because Hocuspocus only calls `onDisconnect` for authenticated connections.
- **Update guard** (`sync-server/src/update-guard.ts`, `beforeHandleMessage`): checks each message before Hocuspocus applies it. Size caps from `sync-server/src/limits.ts`: `SYNC_MAX_MESSAGE_BYTES` (17 MiB, also the WebSocket `maxPayload`), `SYNC_MAX_UPDATE_BYTES` (16 MiB), `SYNC_MAX_DOCUMENT_BYTES` (16 MiB; pure deletions always pass so an oversized document can be trimmed). Every write to the `meta` map must pass `shared/utils/documents/ymetaValidation.ts`, the same contract as `PUT /api/docs/:docId/meta`; nested Y types inside `meta` are refused. Read-only connections may not send stateless frames, which Hocuspocus would relay to every editor. A rejection closes the document connection with a reason from `shared/contracts/syncClose.ts`; the editor shows a "changes were not saved" banner and stops reconnecting. Unexpected guard errors fail closed.
- **Pre-auth guard** (`sync-server/src/pre-auth-guard.ts`): Hocuspocus queues messages until a document has authenticated. The guard caps that queue per socket (`SYNC_MAX_PREAUTH_BYTES`, 32 MiB) and across all sockets (`SYNC_MAX_PREAUTH_TOTAL_BYTES`, 256 MiB) and closes sockets that queue frames without authenticating within `SYNC_AUTH_TIMEOUT_MS` (15 s).
- **Awareness** (`sync-server/src/awareness-guard.ts`): every client's awareness `user` field is normalised with `shared/utils/documents/awarenessUser.ts` before it is relayed. There is no avatar URL field; anonymous visitors broadcast a random avatar seed.
- **Corrupted documents stay loadable**: `readMetaSnapshot` (`sync-server/src/meta-snapshot.ts`) never throws; an unreadable theme hashes to a fixed value, so a valid theme can be written over it.

## Activity logging

On every store the server compares the text and the `meta` snapshot with the previous state and posts `edit`, `title.changed` and `theme.changed` rows to the app (`POST /api/internal/activity`, fire-and-forget, 5 s timeout). Each row carries `yjsDocIdBefore` / `yjsDocIdAfter`, the `yjs_documents` row ids around the store, so the Activity Log can show diffs and restore (see [activity-log.md](activity-log.md)). Comment changes are mirrored with `POST /api/internal/comments-snapshot`.

Attribution comes from the editing connection's JWT, never from the client-chosen awareness name. The last editor is recorded in `onChange`; if that record is missing (cold document, Valkey down), the fallback is the JWT identity of the writer connection whose awareness changed last. Anonymous editors are logged as "Anonymous" with the avatar seed their connection broadcast.

Per-document state lives in Valkey (`sync-server/src/sync-state.ts`) so several sync instances can share it, each key with a 24 h TTL:

| Key | Content |
|---|---|
| `sync:last-editor:{docId}` | JWT identity of the last editor |
| `sync:prev-text:{docId}` | Text at the last store (diff baseline) |
| `sync:prev-meta:{docId}` | Title + theme hash at the last store |

Valkey errors never block sync: a missing baseline skips that edit row, a missing editor uses the fallback.

## Multiple instances

Hocuspocus keeps each loaded document in one process, so production routes WebSocket clients with a sticky cookie at Traefik (`docker-compose.prod.yml`). Two instances can still store the same document at the same time; the partial unique index `uq_activity_doc_yjsafter` on `activity_log` drops the duplicate `edit` / `title.changed` / `theme.changed` row (`server/api/internal/activity.post.ts` logs `[activity] dedup skipped insert`). When two instances read the same `prev-text` baseline, the surviving row's line counts can be slightly off. That is accepted: the counts are a summary, and a lock around every store would make writes depend on Valkey.

## Shutdown

SIGTERM stops the compaction sweeper, calls `server.destroy()` (drains connections and pending stores), closes the Postgres pool and Valkey. A 25 s timer forces exit; compose gives the container 30 s.

## Tests

- Unit tests run from the root workspace and import `sync-server/src/*` directly: `tests/unit/sync/`. Tests that build `Y.Doc`s for sync-server helpers import Y from `sync-server/src/yjs.ts`, because Y.js relies on `instanceof` and the sync server has its own copy of the package.
- Integration tests against the real sync container: `tests/integration/sync/` (for example `syncHardening.test.ts` and `connectionRevocation.test.ts`). `docker-compose.test.yml` sets low `SYNC_MAX_*` / `SYNC_AUTH_TIMEOUT_MS` values that must match the constants in `syncHardening.test.ts`.
