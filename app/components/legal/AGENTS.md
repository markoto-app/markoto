# Privacy / legal surfaces

The four user-facing privacy components. They sit at the layout level (above the editor, above the dashboard) and deliberately don't share much state — each is a self-contained policy enforcer.

| Component | What it does |
|---|---|
| `OnboardingGate.vue` | Blocking modal on first sign-in — user must confirm age ≥16 + accept Privacy + ToS before the app shell mounts. Also re-prompts when `PRIVACY_VERSION` / `TOS_VERSION` bumps invalidate prior acceptance. |
| `ConsentBanner.vue` | CNIL-grade equal-prominence cookie banner. Three purposes (essential / analytics / session_replay). Layered on top of the gate so legal-page reads are unblocked. |
| `AccountDeletionConsequencesModal.vue` | Full confirmation modal shown when the user clicks "Delete account" on the profile page. Lists exactly what gets deleted, anonymised, and cascaded; type-to-confirm the email. |
| `AccountDeletionGraceBanner.vue` | Top-of-app banner shown to users in the 30-day grace period — countdown + cancel button. Compact mode on mobile. |

## Layout

Mounted high in `app/layouts/default.vue` (and any other layout that's not `/legal/*`). The gate and banner are independent of the editor; they're not inside `EditorLayout`.

```
<NuxtLayout>
  <AccountDeletionGraceBanner />     ← top of viewport, only when grace period active
  <NuxtPage />
  <ConsentBanner />                   ← bottom, layered above OnboardingGate when both apply
  <OnboardingGate />                  ← centred modal, blocks everything beneath
</NuxtLayout>
```

`/legal/*` routes are exempt from BOTH the gate and the banner. That's load-bearing — the user must be able to read what they're being asked to accept. Check `route.path.startsWith('/legal/')` in both components in lockstep.

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

## ConsentBanner

The state model is **anon-id-keyed, NOT user-keyed.** A device + browser is what gives consent; logging in later doesn't restart the dialog. The flow:

1. On mount, read `markoto-anon-id` cookie. If absent, mint a `nanoid()` and `Set-Cookie` it (1 year, lax samesite, first-party). This is the consent identity.
2. Fetch `GET /api/consent?anonId=…` — returns the latest `consent_log` row for that anon-id, or null.
3. If null OR `version < CONSENT_VERSION` → show banner.
4. On Save / Accept all / Reject all, POST `/api/consent` with `{ anonId, userId?, purposes: { essential, analytics, session_replay }, version }`. Append-only; never UPDATE.
5. Dispatch `markoto:consent-updated` on `window`. Analytics modules listen for this and (un)mount themselves accordingly. **Don't read the cookie directly** from anywhere except this banner — go through the event.
6. Banner self-unmounts.

Footer link "Privacy choices" + Profile-page button dispatch `markoto:reopen-consent` to bring the banner back. Both surfaces show the user's current state ("analytics: granted on 2026-04-12") so re-opening doesn't feel like starting over.

**Equal-prominence Reject and Accept** is non-negotiable (CNIL standard, confirmed in the EDPB cookie-banner guidelines). Both buttons are the same size, same weight, same colour family. "Customize" is a tertiary affordance.

`essential` is always granted but recorded — the audit story is "user gave consent on YYYY-MM-DD, including for essential cookies", not "user gave consent for non-essential". This matters for the right-to-erasure of the consent record itself.

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

The actual purge is async — see `server/utils/accountDeletionExecute.ts` for the 10-step cascade. The modal does NOT execute the purge.

## AccountDeletionGraceBanner

Top-of-viewport banner with countdown + cancel button. Visible whenever `deletionRequestedAt` is set on the user. Compact mobile mode (just "X days left · Cancel"); desktop adds a sentence explaining what happens at deadline.

Cancel button POSTs `/api/user/delete-cancel` (one segment, NOT `/delete/cancel` — see project gotchas). Endpoint calls `cancelAccountDeletion(userId)` which nulls `deletion_requested_at` + audits `account.delete_cancelled`. On success: `useAccountStatus().refresh()`; banner self-unmounts.

Dark-mode background is **flat sumi-800** (intentionally — the banner sits on the chrome, not on a card surface; same flat-sumi-950 reasoning that drives the canonical Wordmark).

## Cross-cutting conventions

- **All copy goes through `t('legal.*')`.** The keys are pinned by `tests/unit/legal/i18nKeys.test.ts` — adding a key without registering it in the test produces a literal-key render in the UI which a human review can miss but the test catches. Profile-page keys are at `settings.profile.*`, NOT under `legal.*` (the profile page is more than legal).
- **`UModal` testid prop doesn't propagate.** Reka UI's slot composition strips the prop. Move `data-testid` to a wrapper div inside `<template #content>` so flow tests can target it.
- **Dropdown menuitems are matched by `data-testid` on the underlying `<button>`**, not by visible text — text matches race SSR/hydration. Pattern from `password-protect` flow: `data-testid="user-menu-trigger"` + `data-testid="menu-delete-account"`.
- **`useAccountStatus()` is a `useState`-backed composable** so all four components see the same reactive snapshot. Calling `refresh()` re-fetches `/api/user/account-status`; don't add `useFetch` of the same endpoint inside individual components — they'll race.
- **Logout after delete-request still fires `window.location.href = '/'`**, not `navigateTo('/')`. Soft-navigate leaves a half-stale `useAccountStatus` and 401-toast spam; the cross-tab BroadcastChannel logout receiver expects a hard refresh.

## Out of scope here

- **Legal page rendering** — that's `app/pages/legal/[slug].vue` + `server/api/_internal/legal/[slug].get.ts`. Markdown source lives in `content/legal/`.
- **Abuse reporting form** — `app/pages/legal/abuse.vue` (login-gated form posting to `/api/abuse-reports`). Not a privacy modal; it's its own page. Admin triage queue lives at `/admin/abuse-reports`.
- **The actual deletion purge** — `server/utils/accountDeletionExecute.ts`, run by the sweep plugin. The UI only requests + cancels.
- **DPA acceptance modal** — currently piggy-backs on the new-workspace dialog (workspace-owner-only). When extracted, it'll be a fifth component here.
