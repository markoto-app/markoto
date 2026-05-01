# Document Composables

Three-file split for the editor's document lifecycle:

- **`useDocToken.ts`** — fetches `/api/docs/:docId/token`; seeds initial theme + doc context fields + template body; handles password-verify reconnect. Exposes: `token, readOnly, requiresPassword, forbidden, accessMode, isOwner, hasOwner, initialTheme, initialDescription, initialAudience, initialLanguage, initialBody, pendingPasswordUnlock, setAccessMode`.
- **`useHocuspocusSync.ts`** — provider lifecycle only. `getToken()` callback for reconnects. Exposes: `provider, status, synced, userCount, docSizeBytes, reconnect`.
- **`useDocument.ts`** — thin orchestrator. Creates Y.Doc + awareness + undoManager, composes the workers, owns the title/theme/description/audience/language bridges (`ymeta.observe` → Vue refs + computed setters with owner-debounced DB persist), deletion observer (`ymeta._deleted`), welcome-doc/template seeding.

## Key invariants

- **Single consolidated fetch on init** — token endpoint returns metadata + theme + doc context + rendered template body; no separate `/meta` call.
- **Single Awareness instance** passed to both provider AND yCollab.
- Title/theme/description/audience/language **bridged via `ymeta.observe()`** → Vue refs + computed setters.
- **`requiresPassword` flips false only on `onSynced`** to prevent the empty-doc-prepend bug.
- **First-sync-or-disconnect-without-sync** seeds `initialBody` (template) when present, falling back to `welcomeMarkdown`, gated on `ytext.length === 0` so existing content is never overwritten.

## Adding fields to `ymeta`

When you add, rename, or remove a key on the shared `ymeta` Y.Map (title, theme,
description, audience, language, templateId, the deletion sentinel, etc.) follow
the **Y.js schema migration playbook** in `sync-server/AGENTS.md`. The TL;DR: ship
the read path one release ahead of the write path, never make a new key
required-without-fallback, and invert the order when removing. Mixed-version
clients will be live in the same doc — Y.Doc binary state handles it, but the
application-level contract on which keys exist is your responsibility.

## Edit-access mirroring

`canEditTheme` mirrors content edit access: read-only = false, owner = true, anonymous on ownerless doc = true. Description/audience/language follow the same gate (read-only = no writes; non-owner editors can change ymeta but the DB persist is owner-only — Y.js becomes the durable record on ownerless docs).

## Other composables here

- `useAI.ts` — agentic prompt + selection-popup pipeline; talks to `/api/ai/prompt` and rides on awareness for status display.
- `useComments.ts` — `Y.Array<Y.Map>` "comments" wrapper. Author identity from awareness; `observeDeep` for nested replies.
- `useImageUpload.ts` — presigned PUT flow.
- `useVoicePrompt.ts` / `useVoiceDictation.ts` — see `server/utils/agentic/AGENTS.md` for the server-side counterparts.
- `useErrorHandler.ts` — central toast + status mapping. Has a deliberate 402 carve-out so `useAI`'s budget-CTA toast can run.
- `usePagedPreview.ts` — see `app/utils/AGENTS.md` for the rendering pipeline.
