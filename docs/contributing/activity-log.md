# Activity Log

The Activity Log is the per-document feed in the editor's right sidebar: who edited, commented, changed the title or design, which AI tools ran, and restores. Collaborators can open the change behind a row and restore the document to an earlier point. Agent rules for the components are in [`app/components/collab/AGENTS.md`](../../app/components/collab/AGENTS.md).

It is separate from the audit log (`audit_log`, `server/repos/audit.ts`), which records security- and billing-relevant events for operators and workspace admins. A comment edit belongs in `activity_log`; a role change or a Stripe event in `audit_log`.

## Where rows come from

Rows live in `activity_log` (`server/db/schema/collab.ts`, `server/repos/activity.ts`). Actions: `edit`, `join`, `leave`, `comment.added` / `replied` / `resolved` / `reopened` / `deleted`, `theme.changed`, `title.changed`, `ai.tool`, `ai.job`, `ai.job.reverted`, `restore`. The column is a text enum, so a new action is a TypeScript change only.

- `edit`, `title.changed`, `theme.changed` are written by the sync server after each store (see [sync-server.md](sync-server.md#activity-logging)). The actor name comes from the editing connection's JWT, never from the awareness name a client chooses; anonymous editors appear as "Anonymous" with their per-tab avatar seed.
- Comment, AI tool and restore rows are written by the app's endpoints.
- Edit-like rows carry `yjsDocIdBefore` / `yjsDocIdAfter`: the `yjs_updates` ids on either side of the change. Diffs and restores replay the document to those ids (`server/utils/documents/historyReplay.ts`).

## The feed (`app/components/collab/ActivityFeed.vue`)

- One card per row. AI and MCP rows show the seal disc and a per-tool icon; people get `<CommonUserAvatar>` seeded from their user id or, for anonymous rows, from `actor_avatar_seed`.
- Filter chips `all / edits / comments / ai / meta`; the categorisation is `categoryOf` in `app/utils/collab/activityFeedHelpers.ts` (unit-tested without mounting the component).
- The feed reloads every 30 s and 3 s after the local `Y.Doc` stops changing (the sync server logs 2–10 s after the last edit); both pause while the tab is hidden. Relative timestamps re-render every 30 s via `useNow`.

## Viewing a change

A row that `isExpandable` opens a lazy drawer chosen by `expansionFor` (both in `ActivityFeed.vue`):

| Rows | Drawer | Data |
|---|---|---|
| `edit`, `restore` | `ActivityRowDiff.vue` → `DiffView.vue` | `GET /api/docs/:docId/activity/:activityId/diff` replays the text at both boundary ids and returns hunks (`server/utils/documents/textDiff.ts`, capped at 200 hunks) |
| `comment.*` | `ActivityRowCommentContext.vue` | `GET …/comment-context`: the thread as it was, from the snapshots the sync server posts to `/api/internal/comments-snapshot` (written under a per-document advisory lock) |
| `ai.tool` | `ActivityRowAiTool.vue` | the row's `metadata`, no fetch |

## Restoring

The restore button (history icon) opens `RestoreConfirmModal.vue` and posts `POST /api/docs/:docId/activity/:activityId/restore`. It is hidden for read-only viewers and for rows without `yjsDocIdBefore` (the endpoint answers 410 for those). The target is the row's `yjsDocIdBefore`: the state just before that change.

`restoreDocToYjsId` (`server/utils/documents/restoreDoc.ts`) runs inside one Postgres transaction holding `pg_advisory_xact_lock(hashtext(docId))`:

1. Read the newest `yjs_updates` id of the document: the live state before the restore.
2. Replay the document at the target id. If history retention has pruned that point (the sync server's `COMPACT_RETAIN_HISTORY_DAYS`, off by default), it throws `RestorePointCompactedError` and the endpoint answers 410 (error code `docs/restore-compacted`); the diff of such a row answers 410 (`docs/diff-unavailable`). Snapshots never make a point unavailable.
3. Connect a short-lived Hocuspocus client as the acting user (principal `restore:{userId}:{sessionId}`) so collaborators see who restored.
4. In one Y.js transaction, empty the text and comments and insert the past values, and copy the past `meta` values (title, theme, description, audience, language, template). Transient keys such as `_deleted` are left alone. Every client receives one update.
5. Disconnect and return the boundary ids.

The endpoint then writes a `restore` row whose `yjsDocIdBefore` is the live state from step 1 and whose `yjsDocIdAfter` is the state after the restore. Restoring that `restore` row therefore brings back the document as it was just before the restore: restores are reversible. If the helper fails, no row is written and the document is unchanged.

All three row endpoints look the row up with `getActivityById(activityId, docId)`, so a row id from another document answers 404 and can't be probed through a document the caller can open.

## Tests

| Concern | File |
|---|---|
| Restore order of steps and boundary ids | `tests/unit/documents/restoreDoc.test.ts` |
| Restore endpoint: boundary mapping, atomicity, auth order | `tests/unit/documents/restoreEndpoint.test.ts` |
| Restore endpoint over HTTP: validation, 404 / 410 | `tests/integration/endpoints/activityRestore.test.ts` |
| Edit rows' boundary ids, diff, restore and restoring the restore against the real sync container | `tests/integration/sync/persistence.test.ts` |
| Replay at an id, history floor, restore semantics on the stored log | `tests/repos/yjsPersistence.test.ts` |
| Drawer mount and restore-button gating | `tests/nuxt/ActivityFeed.test.ts` |
| Diff rendering | `tests/nuxt/DiffView.test.ts` |
| `categoryOf` / `isExpandable` | `tests/unit/collab/activityFeedHelpers.test.ts` |
| Comment snapshots | `tests/unit/comments/commentsSnapshotDiff.test.ts`, `tests/integration/endpoints/commentsSnapshotConcurrency.test.ts` |
