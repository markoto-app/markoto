# Privacy surfaces

`OnboardingGate.vue` (age ≥ 16 + Privacy + Terms before the app shell), `AccountDeletionConsequencesModal.vue` (what a deletion removes, anonymises and cascades; type-to-confirm) and `AccountDeletionGraceBanner.vue` (30-day countdown + cancel). They are mounted by `app/components/common/AppOverlays.vue`, outside the editor. There is no cookie banner: markoto uses only strictly necessary storage.

## Rules

- **Legal surfaces are hosted-only.** The onboarding gate mounts only when `useInstanceConfig().legalSurfaces` is true (`NUXT_LEGAL_SURFACES_ENABLED`); tests that need it must set the flag. Never show legal UI unconditionally.
- **Keep the `/legal/*` exemption** in the gate (`path.startsWith('/legal/')`): users must be able to read what they are asked to accept. Any future blocking overlay needs the same exemption.
- **Read account state through `useAccountStatus()`** (`useState`-backed, `refresh()` re-fetches `/api/user/account-status`). Never `useFetch` that endpoint inside a component: the copies race.
- **The deletion modal only requests deletion** (`POST /api/user/delete`); its preview comes from `GET /api/user/deletion-preview`. The purge runs later in `server/utils/privacy/accountDeletionExecute.ts`.
- **The cancel endpoint is `/api/user/delete-cancel`** (one path segment), not `/api/user/delete/cancel`.
- **Keep the modal's confirm row visible**: the dialog is a `flex-col` capped at `max-h-[85vh]` with `shrink-0` header and confirm row, so a mobile keyboard can't push the buttons off-screen.
- **All copy goes through i18n.** Register every key a component uses in `tests/unit/legal/i18nKeys.test.ts`. Profile-page keys live under `settings.profile.*`, not under `legal.*`.
- **`data-testid` on `UModal` doesn't reach the DOM.** Put it on a wrapper element inside `<template #content>`. For dropdown items, put it on the rendered `<button>` (e.g. `user-menu-trigger`), and match by testid, not visible text.
- **Logout and post-deletion sign-out use `window.location.href = '/'`** (via `useLogout`), never `navigateTo()`.

## Adding non-essential storage

Don't, unless it is unavoidable. If it is: add the purpose to `server/utils/privacy/consentDecisions.ts` and `OPTIONAL_CONSENT_PURPOSES`, bump `CONSENT_VERSION`, add a purpose to `server/legal/lawfulBasis.ts` and the privacy text, and build a banner with equal-prominence Reject / Accept, no pre-ticked boxes, no cookie wall, the `/legal/*` exemption, and its height published as `--mk-consent-h` (the product tour reserves it). Load the script only after consent. Every storage key a visitor's browser gets must be listed in the privacy policy (`content/legal/privacy/en.md` §9).
