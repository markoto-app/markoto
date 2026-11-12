# Sync server (Hocuspocus)

How it works (persistence and its durability argument, snapshots and pruning, auth and connection expiry, guards, activity logging, Valkey keys, multi-instance): [`docs/contributing/sync-server.md`](../docs/contributing/sync-server.md).

## Rules

- **Never return a fresh `Y.Doc` from `onLoadDocument` on error.** Re-throw so the connection is refused; an empty doc would let clients' cached state overwrite the real document. A document without rows legitimately loads empty.
- **All `yjs_updates` SQL lives in `src/yjs-store.ts`** (the app's in `server/repos/yjsLog.ts`). No DDL here: the table belongs to the app's migrations.
- **Every write holds the per-document lock** (`pg_advisory_xact_lock(YJS_LOCK_NAMESPACE, hashtext(doc_id))`) until COMMIT. The activity "before" id and the snapshot invariant depend on it.
- **Advance a document's persisted state vector only after its append committed** (`persistence.ts`). Moving it earlier loses the delta of a failed store.
- **A snapshot must cover every row below its id; only pruning deletes, and only below a snapshot.** Never delete rows any other way, and never snapshot a document with an unreadable row.
- **Every connection must have a token expiry.** `onAuthenticate` sets `context.tokenExpiresAt`; `connected` closes a connection without one. Don't add a code path that authenticates without it.
- **Close for re-authentication only via `closeForReauth`** (`src/connection-expiry.ts`): document close, then socket close, code 4419 / reason `reauthenticate`. The editor only refetches its token on that reason; any other close reason from `shared/contracts/syncClose.ts` makes it stop reconnecting.
- **Never close the app's own server-side clients** (`ai:`, `mcp:`, `restore:` … — `SYNTHETIC_USER_ID_PREFIXES` in `shared/contracts/jwt.ts`) on a document re-auth: it would fail an AI edit or a restore halfway.
- **Hooks that verify tokens must not throw** (`onTokenSync` → `renew`): a throwing hook makes Hocuspocus close with a reason the client doesn't treat as re-auth.
- **Internal routes stay internal.** New `/internal/*` routes go through `handleInternalRequest` (secret check + 404 for requests that came through the edge proxy) and must not be routed by Traefik.
- **Guard work in `beforeHandleMessage` stays synchronous** so message order is preserved, and unexpected errors fail closed as `invalid-update`.
- **Attribution comes from the JWT context only.** Never use the awareness `user.name` for activity rows — it is client-controlled.
- **Valkey is best-effort for sync state.** A Valkey error may skip an activity row; it must never abort sync or a store. Don't wrap the `prev-text` baseline in `WATCH`/`MULTI` to fix the multi-instance line-count race — that is accepted.
- **Don't delete Valkey keys from `onDisconnect` beyond `dropDocState`.** `clientsCount === 0` covers only this instance; the 24 h TTL cleans up.
- **Hocuspocus v3:** use `Server`, not `Hocuspocus`. Don't mutate connection objects; keep per-connection state in Maps keyed on socketId or the connection.
- **Don't add a bundle step.** Hocuspocus's CJS/ESM exports break Bun's bundler; the image runs `bun run src/index.ts`.

## `shared/` imports

- `sync-server` is a Bun workspace package that depends on `@markoto/shared` (`workspace:*`). The image builds from the repo root and installs with `bun install --filter markoto-sync-server --production`: the sync server's dependencies plus `shared/package.json`'s, hoisted into `/app/node_modules`. Anything `sync-server/src` imports from `shared/` must have its npm dependencies listed in `shared/package.json`, or the image fails at startup.
- Code the sync server imports from `shared/` must not import `yjs` (it would pull `yjs` into `@markoto/shared`'s runtime dependencies; Y.js relies on `instanceof`, so a second copy breaks it). Tests that build `Y.Doc`s for sync-server helpers import Y from `sync-server/src/yjs.ts`.

## Changing `ymeta` keys

Old and new clients share the same document during a rollout, and the update guard closes the connection of any client whose `meta` write fails `shared/utils/documents/ymetaValidation.ts`.

1. **Add a key:** extend `isValidMetaValue` and ship the read path (with a default for `undefined`) first. Ship the write path one release later. Never make a new key required without a fallback.
2. **Remove a key:** stop writing it, one release later stop reading it.
3. **Rename a key:** read and write both names for one release, then drop the old one.

## Debugging

- `[hocuspocus] Attribution fallback` in logs: Sentry tag `cause` = `valkey-miss` (cold doc / restart, normal) or `valkey-error` (Valkey down, investigate).
- In dev the sync container reaches the app via `host.docker.internal`, so Nuxt dev must bind `0.0.0.0`.
