# Privacy / legal surfaces

The three user-facing privacy components. There is **no cookie / consent banner**: markoto uses only strictly necessary storage (privacy §9), which needs no consent under ePrivacy Art.5(3). `ConsentBanner.vue` was removed with `CONSENT_VERSION` 2 (its `analytics` / `session_replay` purposes were never backed by a loaded script).

**Hosted-only.** `OnboardingGate` mounts only when `useInstanceConfig().legalSurfaces` is true (`NUXT_LEGAL_SURFACES_ENABLED`, see `shared/config/instance.ts`); `/api/user/account-status` reports every acceptance as not-required when off, the workspace DPA step disappears, `/legal/*` pages + endpoints 404 and the footer drops its legal links. Self-hosted instances run with them off by default; the hosted SaaS sets the flag in its env. Tests that need the surfaces must set the flag (integration + flow stacks do). They sit at the layout level (above the editor, above the dashboard) and deliberately don't share much state — each is a self-contained policy enforcer.

| Component | What it does |
|---|---|
| `OnboardingGate.vue` | Blocking modal on first sign-in — user must confirm age ≥16 + accept Privacy + ToS before the app shell mounts. Also re-prompts when `PRIVACY_VERSION` / `TOS_VERSION` bumps invalidate prior acceptance. |
| `AccountDeletionConsequencesModal.vue` | Full confirmation modal shown when the user clicks "Delete account" on the profile page. Lists exactly what gets deleted, anonymised, and cascaded; type-to-confirm the email. |
| `AccountDeletionGraceBanner.vue` | Top-of-app banner shown to users in the 30-day grace period — countdown + cancel button. Compact mode on mobile. |

## Layout

Mounted high in `app/layouts/default.vue` (and any other layout that's not `/legal/*`). The gate and banner are independent of the editor; they're not inside `EditorLayout`.

```
<NuxtLayout>
  <AccountDeletionGraceBanner />     ← top of viewport, only when grace period active
  <NuxtPage />
  <OnboardingGate />                  ← centred modal, blocks everything beneath
</NuxtLayout>
```

`/legal/*` routes are exempt from the gate. That's load-bearing — the user must be able to read what they're being asked to accept (`route.path.startsWith('/legal/')`). A future consent banner needs the same exemption.

## OnboardingGate

Reads `useAccountStatus()` (the `useState`-backed composable that hydrates `/api/user/account-status`):
- `ageConfirmedAt` null → show age checkbox
- `privacyVersionAccepted < PRIVACY_VERSION` → show privacy section
- `tosVersionAccepted < TOS_VERSION` → show ToS section
- DPA is NOT in the gate — only the consequences modal on workspace creation surfaces it (B2B-only)

On accept:
1. POST to `/api/user/onboarding/accept` with `{ privacy: true, tos: true, age: true, locale: i18n.locale }`. The endpoint calls `applyOnboardingAcceptance(userId, {...})` which writes `*_version_accepted`, `*_locale`, and `age_confirmed_at` in one update.
2. `useAccountStatus().refresh()` so the gate evaluates falsy and unmounts.
3. Audit row written: `account.age_confirmed`, `policy.accepted` (one per accepted document).

On version bump (a published code change to `shared/legal/versions.ts`), users with stale acceptance see the modal again — no migration needed.

## Cookies (no banner)

What visitors see: no banner. The footer (`LegalFooter.vue`) shows "Cookies: essential only" (`legal.footer.cookieNote`) linking to `/legal/privacy`, whose §9 lists every cookie / storage key (keep it in step with the code: `nuxt-session`, `ypad_locale`, `markoto-anon-creator`, `markoto-anon-terms`, `nuxt-color-mode`, `markoto:preview-zoom`, `markoto-pending-invite`, `markoto-anon-avatar` (session storage, `app/utils/collab/userAvatar.ts`), the PWA cache); the profile page's Legal section adds `settings.profile.legal.cookieNote`. The `consent_log` table and `GET/POST /api/consent` stay (nothing calls them; `CONSENT_PURPOSES = ['essential']`, `OPTIONAL_CONSENT_PURPOSES = []`, so `promptRequired` is always false). v1 rows stay as the Art.7(1) record (exported, anonymised on deletion).

Bringing a banner back (only if non-essential storage is ever added): add the purpose to `server/utils/privacy/consentDecisions.ts` + `OPTIONAL_CONSENT_PURPOSES`, bump `CONSENT_VERSION`, add a `lawfulBasis.ts` purpose + privacy text, and build the banner with equal-prominence Reject/Accept (CNIL / EDPB), no pre-ticked boxes, no cookie wall, the `/legal/*` exemption, and publish its height as `--mk-consent-h` (the product tour reserves it). Load the script only after consent.

## AccountDeletionConsequencesModal

Built as the explicit alternative to a one-button "delete?" — every consequence is enumerated so the user understands what's happening before typing the confirmation. The modal pulls the consequence list from `useAccountStatus()` workspace fates (computed server-side by `planAccountDeletion(userId)`):

- **Owned + sole-member workspaces** → cascade-delete the whole workspace.
- **Owned + multi-member workspaces** → promote the longest-tenured other admin to owner, then delete the user's membership. The promoted admin is named in the modal so the user can see who inherits.
- **Workspaces where the user is a member, not owner** → just remove their membership.

Below the workspaces section, three groups:
- **Deleted:** owned docs (incl. anonymous), saved themes, AI usage / sessions, queued exports, Stripe customer
- **Anonymised, not deleted:** comments on others' docs, activity-log attribution, audit-log actor, consent-log actor — all flip to "Deleted user" / null FK
- **Manual steps suggested before deletion:** export your data, transfer ownership of any docs you want preserved, invite a workspace member if you want the workspace to survive, download knowledge files

Bottom row: 30-day grace timing copy + a type-to-confirm field bound to the user's email (case-insensitive). Cancel + confirm buttons stay visible because of `flex-col max-h-[85vh]` + `shrink-0` on the confirm row — without this, mobile keyboards push the buttons below the viewport.

On confirm:
1. POST `/api/user/delete` → `requestAccountDeletion(userId, reason)` flips `deletion_requested_at` to now and audits `account.delete_requested`.
2. Send the "deletion scheduled" transactional email (kind `account.deletion.requested`) with the cancel-by date.
3. Modal closes; `AccountDeletionGraceBanner` mounts.

The actual purge is async — see `server/utils/privacy/accountDeletionExecute.ts` for the 10-step cascade. The modal does NOT execute the purge.

## AccountDeletionGraceBanner

Top-of-viewport banner with countdown + cancel button. Visible whenever `deletionRequestedAt` is set on the user. Compact mobile mode (just "X days left · Cancel"); desktop adds a sentence explaining what happens at deadline.

Cancel button POSTs `/api/user/delete-cancel` (one segment, NOT `/delete/cancel` — see project gotchas). Endpoint calls `cancelAccountDeletion(userId)` which nulls `deletion_requested_at` + audits `account.delete_cancelled`. On success: `useAccountStatus().refresh()`; banner self-unmounts.

Dark-mode background is **flat sumi-800** (intentionally — the banner sits on the chrome, not on a card surface; same flat-sumi-950 reasoning that drives the canonical Wordmark).

## Cross-cutting conventions

- **All copy goes through `t('legal.*')`.** The keys are pinned by `tests/unit/legal/i18nKeys.test.ts` — adding a key without registering it in the test produces a literal-key render in the UI which a human review can miss but the test catches. Profile-page keys are at `settings.profile.*`, NOT under `legal.*` (the profile page is more than legal).
- **`UModal` testid prop doesn't propagate.** Reka UI's slot composition strips the prop. Move `data-testid` to a wrapper div inside `<template #content>` so flow tests can target it.
- **Dropdown menuitems are matched by `data-testid` on the underlying `<button>`**, not by visible text — text matches race SSR/hydration. Pattern from `password-protect` flow: `data-testid="user-menu-trigger"` + `data-testid="menu-delete-account"`.
- **`useAccountStatus()` is a `useState`-backed composable** so the components see the same reactive snapshot. Calling `refresh()` re-fetches `/api/user/account-status`; don't add `useFetch` of the same endpoint inside individual components — they'll race.
- **Logout after delete-request still fires `window.location.href = '/'`**, not `navigateTo('/')`. Soft-navigate leaves a half-stale `useAccountStatus` and 401-toast spam; the cross-tab BroadcastChannel logout receiver expects a hard refresh.

## Out of scope here

- **Legal page rendering** — that's `app/pages/legal/[slug].vue` + `server/api/_internal/legal/[slug].get.ts`. Markdown source lives in `content/legal/`.
- **Abuse reporting form** — `app/pages/legal/abuse.vue` (open to everyone where the anonymous gate is on — ALTCHA bot check — else login-gated; posts to `/api/abuse-reports`). Not a privacy modal; it's its own page. Admin triage queue lives at `/admin/abuse-reports`.
- **The actual deletion purge** — `server/utils/privacy/accountDeletionExecute.ts`, run by the sweep plugin. The UI only requests + cancels.
- **DPA acceptance modal** — currently piggy-backs on the new-workspace dialog (workspace-owner-only). When extracted, it'll be a fifth component here.
