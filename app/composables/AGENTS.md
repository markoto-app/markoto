# Composables

Grouped by domain (`account/`, `ai/`, `billing/`, `comments/`, `document/`, `editor/`, `marketing/`, `platform/`, `preview/`). A composable's internal parts sit next to it (`documentMeta.ts`, `aiSessionTracking.ts`, `voiceCapture.ts` …); its public API is the `use*` function callers import. Every file here is auto-imported, so give exports names that can't collide. Preview rendering: `app/utils/AGENTS.md`. Sync server side of the connection: [`docs/contributing/sync-server.md`](../../docs/contributing/sync-server.md).

## Document lifecycle (`document/`)

`useDocToken.ts` (token flow; the fields and the per-answer writers are in `docAccessState.ts`), `useHocuspocusSync.ts` (provider lifecycle), `useDocument.ts` (orchestrator: `Y.Doc`, awareness, token → provider → sync wiring, template seeding), `documentMeta.ts` (the `ymeta` bridges: title, theme, document context, deletion flag).

`editor/` holds the editor page's wiring that `EditorLayout.vue` composes (exports + print shortcut, dictation, comments, text stats, view mode, inserts, sync-problem toasts).

- **One token fetch seeds everything.** `GET /api/docs/:docId/token` returns metadata, theme, document context and the rendered template body. Don't add a separate `/meta` fetch; the only exception is `hydrateAfterUnlock` after a password unlock (a gated visitor's `/token` carries no metadata).
- **Pass the provider a token accessor, never a token string.** It is called on every (re)connect and when the sync server asks for a renewal (`getToken({ renewal })` → `getFreshToken`). A still-valid token is reused; a token near expiry, marked stale, or requested by the server is refetched from `/token`; a failed refetch keeps the current token.
- **A `reauthenticate` close is not an error.** `useHocuspocusSync` calls `onReauthRequired` → `invalidateToken()`, and the next connect refetches. When `/token` no longer issues a token, `useDocument` disconnects and the no-access or password screen shows. Other close reasons from `shared/contracts/syncClose.ts` stop reconnecting and show the "not saved" banner.
- **On an auth failure retry once with a fresh token** (`authRetried`) before marking the editor read-only.
- **One Awareness instance**, created in `useDocument`, passed to both the provider and yCollab.
- **`ymeta` values are not Vue-reactive.** Bridge them with `ymeta.observe()` → ref + computed setter. Setters refuse writes when read-only; only the owner's editor persists to the database.
- **Seed the template only in `onSynced`**, only into an empty text, never when read-only. Never seed on a disconnect that never synced: the local insert would merge with the server's content on reconnect. Known gap: two clients opening a brand-new document in the same handshake window can both seed.
- **`pendingPasswordUnlock` is cleared only on `onSynced`** (`clearPendingUnlock`), so the editor doesn't mount on an empty doc and prepend to it.
- **Changing `ymeta` keys:** follow the rollout order in `sync-server/AGENTS.md` → "Changing `ymeta` keys"; the sync server closes connections that write keys it can't validate.

## Other rules

- **`usePagedPreview` serialises renders.** A render requested while paginating is queued (`pendingRender`) and drained on `paginated` / `iframe-error`. Don't start a second render in parallel: both swap into `#mount` and the preview goes blank.
- **`useErrorHandler` lets 402 through** so the AI budget call-to-action can render; don't add a generic 402 toast.
- **`useLogout` posts to the `markoto-auth` BroadcastChannel; `app/plugins/auth-broadcast.client.ts` reloads the other tabs.** Keep it a full reload, never an in-place state reset.
- **Version skew:** `app/plugins/version-check.client.ts` (glue) + `app/utils/platform/versionCheckController.ts` (pure, unit-tested) compare the bundle's build id with `GET /api/version` and watch the PWA's `needRefresh`; one toast, 30 s auto-reload, 5 min snooze. Keep the logic in the controller, not in the plugin.
