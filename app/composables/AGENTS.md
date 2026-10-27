# Document Composables

Three-file split for the editor's document lifecycle:

- **`useDocToken.ts`** — fetches `/api/docs/:docId/token`; seeds initial theme + doc context fields + template body; handles password-verify reconnect; owns `getFreshToken()` (F5, below). A gated visitor's `/token` carries NO metadata (private-doc metadata stays private), so after a password unlock `hydrateAfterUnlock(jwt)` fetches `/meta` with the unlock JWT as Bearer and re-seeds before the reconnect. `canDelete` is server-computed (owner / workspace admin / the browser that created an anonymous doc) and gates the File-menu Delete. Exposes: `token, readOnly, requiresPassword, forbidden, canDelete, accessMode, isOwner, hasOwner, initialTheme, initialDescription, initialAudience, initialLanguage, initialBody, pendingPasswordUnlock, fetchToken, hydrateAfterUnlock, getFreshToken, setAccessMode`.
- **`useHocuspocusSync.ts`** — provider lifecycle only. The `getToken` accessor is passed straight to HocuspocusProvider's `token` option (wrapped in `Promise.resolve`), so the provider re-invokes it on every reconnect. Exposes: `provider, status, synced, userCount, docSizeBytes, reconnect`.
- **`useDocument.ts`** — thin orchestrator. Creates Y.Doc + awareness + undoManager, composes the workers, owns the title/theme/description/audience/language bridges (`ymeta.observe` → Vue refs + computed setters with owner-debounced DB persist), deletion observer (`ymeta._deleted`), welcome-doc/template seeding.

## Key invariants

- **Single consolidated fetch on init** — token endpoint returns metadata + theme + doc context + rendered template body; no separate `/meta` call.
- **Single Awareness instance** passed to both provider AND yCollab.
- Title/theme/description/audience/language **bridged via `ymeta.observe()`** → Vue refs + computed setters.
- **`requiresPassword` flips false only on `onSynced`** to prevent the empty-doc-prepend bug.
- **Token refresh on reconnect (F5).** The doc JWT has a 2h TTL and Hocuspocus only re-auths at the handshake, so a session open >2h that drops and auto-reconnects would replay a dead token → `onAuthenticationFailed` → `markReadOnly` (silent read-only downgrade). The provider is handed `getToken` as an **accessor** (not a resolved string), and `useDocToken.getFreshToken()` decodes the current JWT's `exp` and refetches `/token` when it's within 60s of expiry — so reconnects present a live token. Guardrails: a still-valid token is reused (no per-reconnect refetch); a password-gated doc returns `token: null` from `/token`, so the refresh **keeps** the existing (password-derived) token rather than clobbering it to empty (that reconnect may still fail auth, exactly as before — never worse); a refetch error falls back to the current token. `getFreshToken` is a *narrow* token-only refresh — it does NOT re-run the full `fetchToken` (theme/doc-context/ownership stay put).
- **Welcome/template seeding happens ONLY on `onSynced`** (authoritative empty-doc check), seeding `initialBody` (template) when present, falling back to `welcomeMarkdown`, gated on `ytext.length === 0` so existing content is never overwritten. **F9:** it must NOT seed on a never-synced disconnect — a local seed on a doc we never synced merges with the server's real content when the provider auto-reconnects, corrupting it. An unreachable server shows an empty editor + "disconnected" status; the doc seeds if/when a real sync lands empty. The genuinely-serverless dev path (no `syncUrl`) still seeds because `connect()` routes it through `onSynced`. Residual (separate from F9, not yet closed): two clients opening a brand-new never-seeded doc within the same sync-handshake window both `onSynced` empty and both seed → duplicated welcome. The durable fix is server-side seeding at doc creation; client seeding can't mutually exclude concurrent first-openers.

## Edit-access mirroring

`canEditTheme` mirrors content edit access: read-only = false, owner = true, anonymous on ownerless doc = true. Description/audience/language follow the same gate (read-only = no writes; non-owner editors can change ymeta but the DB persist is owner-only — Y.js becomes the durable record on ownerless docs).

## Other composables here

- `useAI.ts` — agentic prompt + selection-popup pipeline; talks to `/api/ai/prompt` and rides on awareness for status display.
- `useComments.ts` — `Y.Array<Y.Map>` "comments" wrapper. Author identity from awareness; `observeDeep` for nested replies.
- `useImageUpload.ts` — presigned PUT flow.
- `useVoicePrompt.ts` / `useVoiceDictation.ts` — see `server/utils/agentic/AGENTS.md` for the server-side counterparts.
- `useErrorHandler.ts` — central toast + status mapping. Has a deliberate 402 carve-out so `useAI`'s budget-CTA toast can run.
- `useBilling.ts` — wraps `/api/user/me` for plan + interactions-remaining; powers the AIPromptBar count chip and the upsell toast.
- `useBillingMode.ts` — SSR-hydrated billing mode (`billingEnabled`, `plansComingSoon`, `pricingVisible`). See `app/AGENTS.md` → "Billing mode on the client".
- `useLogout.ts` — calls `/api/_auth/logout`, clears the local session, then posts a `logged-out` message on the `LOGOUT_CHANNEL_NAME` BroadcastChannel. The receiver lives in `app/plugins/auth-broadcast.client.ts` and reloads other tabs (full reload, not in-place clear — too many tendrils into the editor / AI / awareness state-machines for an in-place tear-down to be trustworthy).
- `usePagedPreview.ts` — see `app/utils/AGENTS.md` for the rendering pipeline. **Render-race serialisation:** two concurrent `__renderDoc` calls overlapped on rapid edits — paged.js renders into `#pending`, then `replaceChildren`-swaps to `#mount`. If a SECOND render started while the first was still in `previewer.preview()`, the second cleared `#pending` mid-fill, both renders' `replaceChildren` fired, and `#mount` could end up empty. User-visible: preview pane goes blank on rapid edits while the status bar still reports a stale page count (because the `paginated` postMessage fires with the previous render's count). Fix: `render()` short-circuits when `isPaginating === true` and queues the request via the existing `pendingRender` flag; the `paginated` / `iframe-error` postMessage handlers drain the queued render after the current one terminates.

## Version-skew detection (multi-instance / staged rollout)

Two signals, one toast:

1. **`$pwa.needRefresh`** — Workbox flips it when the SW has a new precache. Primary path for installed-PWA users.
2. **`/api/version` poll** — covers non-PWA tabs. Returns `{ buildId }`. Compared against the build id baked into the SPA bundle at build time. Mismatch ⇒ "this tab is older than the server".

Both paths land on the same toast with two actions: **Reload now** (immediate) and **Snooze 5 min** (defer auto-reload). A 30-second auto-reload countdown runs unconditionally once the prompt is shown — we don't try to detect "mid-edit and don't reload"; Y.Doc + Hocuspocus flushes within ~2s, so 30s is comfortably safe and the explicit countdown is more honest than a silent reload.

**Where the state machine lives:** `app/utils/versionCheckController.ts` is pure (no Nuxt deps) so it has unit tests. The `app/plugins/version-check.client.ts` plugin is the glue — toast renderer, `$fetch`, `$pwa` watch, focus + `visibilitychange` re-poll. In dev the comparison is a no-op (`buildId === 'dev'` doesn't change between requests).

**Why a plugin, not a composable:** the controller has to outlive any single page mount and start before the user's first interaction. A composable would couple it to a specific component tree. The unit tests reach the controller directly; the plugin is thin enough that it's covered by integration smoke.

## Adding fields to `ymeta`

When you add, rename, or remove a key on the shared `ymeta` Y.Map (title, theme,
description, audience, language, templateId, the deletion sentinel, etc.) follow
the **Y.js schema migration playbook** in `sync-server/AGENTS.md`. The TL;DR: ship
the read path one release ahead of the write path, never make a new key
required-without-fallback, and invert the order when removing. Mixed-version
clients will be live in the same doc — Y.Doc binary state handles it, but the
application-level contract on which keys exist is your responsibility. Pair this
with the version-skew toast above: a user can only be one rollout-step behind
before the toast forces them up.
