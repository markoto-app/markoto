# Activity Log (Cards, Diffs, Restore)

Right-sidebar feed showing every meaningful change to the doc. Three tiers of depth. Source of truth: `activity_log` table in Postgres, written from the sync-server's `onStoreDocument` hook (edits) and the Nitro endpoints (comments, theme, title, ai.tool, restore). Mirrors the Comments panel visually — same rounded-md card aesthetic, same right-sidebar slot.

**Activity Log vs Audit Log — two different surfaces.** This file documents the *user-facing* Activity Log: per-doc, shown to collaborators, restoreable. The separate `audit_log` table (Phase 2) is *admin-facing*: tracks billing-relevant + security-relevant events (subscription transitions, role changes, knowledge uploads) and is consumed by `server/repos/audit.ts` for admin tooling — not surfaced in any user UI. Don't confuse the two when adding events: a comment edit goes to `activity_log` (collaborators care); a Stripe webhook goes to `audit_log` (only operators care). The two tables share no rows.

## Tier 0 — the feed itself (`ActivityFeed.vue`)

- One card per activity row. Avatar + actor + relative timestamp + action verb + optional detail line.
- **Action vocabulary:** `edit`, `join`, `leave`, `comment.added/replied/resolved/reopened/deleted`, `theme.changed`, `title.changed`, `ai.tool` (with subtype `web_search/fetch_url/generate_image/view_image/search_knowledge/get_knowledge_file`), `restore`. Text-typed enum (adding values is TS-only). Agent rows (AI loop + MCP) render the seal disc and a per-tool icon; humans get `<CommonUserAvatar>` seeded by user id; anonymous rows by `actorAvatarSeed` (`activity_log.actor_avatar_seed`, migration 0027 — the editor's per-tab awareness token, so the row matches the presence avatar; `comment.*` rows take the comment's `authorAvatarSeed`, passed by the comments snapshot but not stored in `document_comments`), falling back to the name for older rows (see `app/AGENTS.md` → User avatars).
- **Filter chips:** `all / edits / comments / ai / meta`. Categorisation lives in `app/utils/collab/activityFeedHelpers.ts:categoryOf` so it can be unit-tested without mounting the SFC. Disabled chips with a 0-count remain visible but greyed out — keeps the layout from jumping as activity arrives.
- **Actor names come from JWTs only.** The sync server attributes `edit` / `title.changed` / `theme.changed` rows from the editing connection's JWT (`userName`), never from the client-chosen awareness `user.name`. Anonymous editors land as `userName: null` + `actorPrincipal: 'anonymous'` and render as "Anonymous" — so nobody can write another person's name (or `markoto`, which the feed treats as an AI row) into the history. See `sync-server/AGENTS.md` → Activity logging.
- **Presence data is normalised.** Awareness `user` fields (name / colour / avatarSeed / id) are normalised by the sync server before relay and again on receipt (`useDocument` + `PresenceBar`, `shared/utils/documents/awarenessUser.ts`) — colours end up in raw style attributes. There is no avatar URL field: avatars are generated locally, anonymous visitors broadcast only a random `avatarSeed` token.
- **Reactive timestamps** via `useNow({ interval: 30_000 })` — labels auto-tick from "just now" → "1 minute ago" without waiting for the 30s polling refetch. One shared interval; pauses with the tab via VueUse's internal `useIntervalFn`.
- **Polling cadence:** 30s safety-net via `useIntervalFn` + reactive Y.Doc-update debounce (3s) so the feed catches sync-server activity within ~3s of the doc settling. `useDocumentVisibility` pauses both when the tab is hidden.

## Tier 1 — "View change" drawer

Per-row expansion showing what actually happened. Click the chevron-down affordance → a lazy-loaded drawer mounts via `defineAsyncComponent`. Three drawer kinds:

- **`ActivityRowDiff`** (edit + restore rows) — fetches `/api/docs/:docId/activity/:activityId/diff`. Server replays Y.js up to `yjsDocIdBefore`, then up to `yjsDocIdAfter`, runs `structuredPatch` (the `diff` library), returns hunks. Rendered by `DiffView.vue` — git-style `@@` headers, +/- markers, kind classes (`bg-green-500/10`, `bg-red-500/10`), 200-hunk truncation banner.
- **`ActivityRowCommentContext`** (comment.* rows) — fetches `/api/docs/:docId/activity/:activityId/comment-context`. Returns the comment thread state at the time of the action. Source: an internal `comments-snapshot` endpoint the sync-server posts when threads change, advisory-locked per-doc to avoid concurrent-write phantom snapshots.
- **`ActivityRowAiTool`** (ai.tool rows) — reads from `entry.metadata` directly (no fetch). Renders the tool name + query/url/prompt/src/knowledgeId.

Routing of action → drawer lives in `expansionFor()` inside `ActivityFeed.vue`. **The eligibility predicate (`isExpandable`) and the renderer (`expansionFor`) are TWO separate functions and both must list the action.** `expansionFor` returns `{is, props}` so the template uses a single `<component :is>` switch. The same `ActivityRowDiff` serves both `edit` and `restore` rows because both carry `yjsDocIdBefore`/`yjsDocIdAfter` boundaries.

## Tier 2 — "Restore to this point"

Snap the live Y.Doc back to a past state. Click the history-icon button (sibling of the expansion caret, `@click.stop` so it doesn't toggle expansion) → `RestoreConfirmModal.vue` opens → confirm → `POST /api/docs/:docId/activity/:activityId/restore`. The doc's content updates live for every connected collaborator via Y.js sync.

Authorization: edit access required. Read-only viewers can SEE Tier 1 diffs but cannot apply restores — the button is HIDDEN (not disabled) for them, mirroring the prompt-bar's hidden-not-disabled rule. Pre-Tier-1 rows (where `yjsDocIdBefore IS NULL`) also hide the button — restoring them would 410 from the endpoint.

The endpoint calls `restoreDocToYjsId()` (in `server/utils/documents/restoreDoc.ts`) then writes a new `restore` activity row with metadata `{kind, restoredFromActivityId, restoredFromTime}`. Atomicity: on helper failure, no activity row is written — the user sees a 500 toast and the doc is unchanged.

## `restoreDocToYjsId` — the execution helper

Wraps four steps in ONE Postgres transaction with a per-doc advisory lock:

1. **Capture `yjsDocIdBeforeRestore`** via `SELECT MAX(id) FROM yjs_documents WHERE docname = $1` — the LIVE pre-restore state. **MUST happen before the WS provider is constructed** (regression target).
2. **Replay the past state** via `reconstructDocAtYjsId(docId, targetYjsId)`.
3. **Open a synthetic Hocuspocus client** as the acting user. JWT principal `restore:{actorUserId}:{sessionId}` (mirrors AI's `ai:assistant:*`). Awareness label = the human actor's name so collaborators see "Joel restored".
4. **Replace ytext + ycomments + ymeta inside ONE Y.js transaction** (origin `restore:{userId}:{sessionId}`). Single broadcast to every client — no flicker. Y.js applyUpdate-on-newer-state ADDS items but doesn't delete divergence, so we explicitly empty the collections first, then apply the past update.
5. **Capture `yjsDocIdAfterRestore`** via the same MAX query.

Concurrency: `pg_advisory_xact_lock(hashtext(docId))` serialises restores per-doc. What does NOT live here: auth (caller's responsibility), the activity-row write (caller writes after success so a replay-time exception leaves no orphan).

## Reversibility — the load-bearing invariant

Restores are reversible: clicking restore on a `restore` row brings the doc back to the LIVE state right before THAT restore landed. The wiring:

- The new `restore` activity row's `yjsDocIdBefore` ← `yjsDocIdBeforeRestore` (the LIVE pre-restore state).
- The new `restore` activity row's `yjsDocIdAfter` ← `yjsDocIdAfterRestore` (the post-restore state).

A future restore from this row uses `yjsDocIdBefore` as its target — i.e., restores to the LIVE state right before this restore. Stamping the SOURCE row's `yjsDocIdBefore` here would silently break this — clicking restore on the new row would re-snap to the same past state. Caught in browser validation; pinned by `tests/unit/documents/restoreEndpoint.test.ts`.

## Cross-doc isolation

`getActivityById(activityId, docId)` is keyed on the (id, docId) tuple. A row from doc B accessed via doc A's URL returns null → 404. Closes the timing oracle where a non-member could probe whether a specific activityId exists by requesting its diff/restore through a doc they DO have access to. Same shape across `/diff`, `/comment-context`, `/restore`.

## Test layout

| Concern | Layer | File |
|---|---|---|
| `restoreDocToYjsId` orchestration + reversibility-capture order | Unit (mocked WS provider + DB) | `tests/unit/documents/restoreDoc.test.ts` |
| `/restore` endpoint handler — boundary-id mapping, atomicity, auth gate order | Unit (mocked deps + h3 globals stubbed) | `tests/unit/documents/restoreEndpoint.test.ts` |
| `/restore` endpoint via real HTTP — validation, auth, 404/410 branches | Integration | `tests/integration/endpoints/activityRestore.test.ts` |
| `<ActivityFeed>` restore-row drawer mount + button gating | Component (mountSuspended) | `tests/nuxt/ActivityFeed.test.ts` |
| `DiffView` rendering | Component | `tests/nuxt/DiffView.test.ts` |
| `activityFeedHelpers` (categoryOf / isExpandable / expansionToggleLabelKey) | Unit | `tests/unit/collab/activityFeedHelpers.test.ts` |
| Comments-snapshot diff replay | Unit | `tests/unit/comments/commentsSnapshotDiff.test.ts` |
| Comments-snapshot concurrency (advisory lock) | Integration | `tests/integration/endpoints/commentsSnapshotConcurrency.test.ts` |

The integration suite can't reach the success-path body assertions on `/restore` (no real Hocuspocus in the integration stack), so the unit-level endpoint test mocks `restoreDocToYjsId`. Real-WS happy-path coverage requires the flow-test stack (`docker-compose.test.yml --profile flows`).

## Gotchas

- **Restore must capture `yjsDocIdBeforeRestore` BEFORE the WS provider is constructed.** The synthetic Hocuspocus client's first-store-document hook lands BEFORE the helper would otherwise read `MAX(id)` — reading after the WS connect would capture an id that already includes part of the restore's own update. Lock-then-read-then-construct, all inside one tx. Pinned by `tests/unit/documents/restoreDoc.test.ts` via the `providerConstructedAtCallIndex` snapshot.
- **The `restore` activity row's `yjsDocIdBefore` is the LIVE pre-restore state, NOT the source row's `yjsDocIdBefore`.** Stamping the source row's value here breaks reversibility. Pinned by `tests/unit/documents/restoreEndpoint.test.ts`. Same shape applies to any future "atomic snapshot of live state" feature: the boundary id you stamp on the new row is the LIVE state, not the target you restored TO.
- **`isExpandable()` and `expansionFor()` MUST list the same actions.** Adding `restore` to `isExpandable` but forgetting `expansionFor` returns null from the renderer — the v-if-gated drawer host never mounts and the click visibly does nothing. Symptom: the chevron rotates (because `data-expanded` flips) but no diff appears. Pinned by `tests/nuxt/ActivityFeed.test.ts`.
- **Iconify renders `<UIcon name="i-lucide-foo">` as `class="iconify i-lucide:foo"` — colon, not hyphen.** Component tests asserting on icon presence need the colon form.
- **Lazy `defineAsyncComponent` doesn't fully resolve in nuxt component tests.** Test the host-mount as the regression target (covers the `expansionFor` branch class of bug); test the inner content separately.
