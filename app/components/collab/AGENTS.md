# Activity Log components

How the feed, diffs and restore work: [`docs/contributing/activity-log.md`](../../../docs/contributing/activity-log.md).

## Rules

- **`activity_log` is not `audit_log`.** Collaborator-facing document events go to `activity_log`; security, billing and admin events go to `audit_log` (`server/repos/audit.ts`). Never write one event to both.
- **`isExpandable` (`app/utils/collab/activityFeedHelpers.ts`) and `expansionFor` (`ActivityFeed.vue`) must list the same actions.** If only `isExpandable` knows an action, the chevron rotates but no drawer mounts. Pinned by `tests/nuxt/ActivityFeed.test.ts`.
- **Hide the restore button, don't disable it**, for read-only viewers and for rows without `yjsDocIdBefore`.
- **A new `restore` row's `yjsDocIdBefore` is the LIVE state read before the restore**, never the source row's `yjsDocIdBefore`; otherwise restoring the restore row re-applies the same past state. Pinned by `tests/unit/documents/restoreEndpoint.test.ts`. The same applies to any future "snapshot of the live state" row.
- **`restoreDocToYjsId` reads `MAX(id)` before it constructs the Hocuspocus provider**, inside the locked transaction. Reading after the connect can include part of the restore's own update. Pinned by `tests/unit/documents/restoreDoc.test.ts` (`providerConstructedAtCallIndex`).
- **Write the activity row only after the restore helper succeeded**, so a failed restore leaves no row.
- **Look rows up with `getActivityById(activityId, docId)`** in every per-row endpoint, so ids from other documents answer 404.
- **Actor names come from JWTs**, never from awareness `user.name` (client-controlled); `markoto` as a name would render as an AI row.

## Test gotchas

- Iconify renders `<UIcon name="i-lucide-foo">` as `class="iconify i-lucide:foo"` (colon). Assert on the colon form.
- `defineAsyncComponent` drawers don't fully resolve in Nuxt component tests. Assert that the drawer host mounts; test the drawer content separately.
