# Vue frontend (`app/`)

Nested guides: `app/composables/AGENTS.md` (document lifecycle, token renewal), `app/utils/AGENTS.md` (preview pipeline, sanitising, vendored assets), `app/components/collab/AGENTS.md` (Activity Log), `app/components/document/AGENTS.md` (document context, new-document dialog), `app/components/legal/AGENTS.md` (privacy surfaces).

Contributor docs: [design system](../docs/contributing/design-system.md), [marketing site, SEO, pricing](../docs/contributing/marketing-site.md), [preview pipeline](../docs/contributing/preview-pipeline.md), [client data: queries vs local state vs Y.js](../docs/contributing/client-data.md).

## Brand rules

- **Shu (the red seal, Tailwind `primary`) means AI, never "click this".** Buttons default to `neutral` (`app/app.config.ts`); use `color="primary"` only on controls that invoke the AI. No `text-primary` on decorative icons or hover states.
- **Represent the AI with `<CommonSeal>` / `<AiThinking>`, never `i-lucide-sparkles`** (banned in user-facing chrome). The only "AI is working" animation is the shu `mk-pulse` keyframes; no gradients, rainbows or spins.
- **Colours:** no bright Tailwind palettes (`blue-`, `amber-`, `violet-`, `orange-` …). Use `shu-*` / `sumi-*`, `success` for success, `error` for errors, `neutral` instead of `info`. Use `bg-default` / `bg-muted` / `bg-elevated` / `text-default` / `text-muted`, not raw white or black; `text-toned` is near-invisible for captions.
- **No drop shadows on cards** (use `bg-default` on `bg-muted`). **No weights above 500** in chrome (`font-semibold` / `font-bold`).
- **Sentence case** for headings and labels. **No emoji** in product UI; Lucide outline icons only.
- **Italic Fraunces is the AI's voice** (and display emphasis only). Use `<strong>` for emphasis in prose.
- **Avatars are generated locally** (`<CommonUserAvatar>`, DiceBear Moods). Never load a provider profile picture or a remote avatar service. The AI keeps the seal disc. Awareness colours come from `app/utils/collab/colors.ts`.

## Common Vue conventions

- **No hard-coded user-facing strings.** Everything goes through vue-i18n in all six locales (`i18n/locales/`). A literal `@` in a locale string must be written `{'@'}` (`@:` starts a linked message). Counts use plurals: `t(key, { n }, n)`.
- **Mobile breakpoint is 639px** (`useMediaQuery('(max-width: 639px)')`, Tailwind `sm:`). Don't introduce 768px. On narrow screens the editor forces `viewMode = 'edit'` instead of split; keep the CodeMirror font at 16px on mobile (iOS zooms below that).
- **Hide the preview with CSS (`hidden xl:block`), not `v-if`**, so resizing past `xl` restores it without remounting.
- **`EditorLayout.vue` composes; it doesn't render details.** Top bar, banners, sidebar panels, status bar … are `components/editor/layout/*` (props down, events up); shared state stays in the layout (`useDocument`, the open sidebar panel, view mode, modals) and the wiring in `composables/editor/`. The theme panel follows the same split (`components/document/theme/`, one component per section on `v-model:theme`).
- **CodeMirror `readOnly` and theme go through Compartments**; read-only state arrives after the token fetch.
- **`ymeta` values are not reactive**: bridge with `ymeta.observe()` (see `app/composables/AGENTS.md`).
- **Never write `:global(.dark) .x` in scoped CSS.** Vue compiles it to a bare `.dark { … }` that styles `<html>`. Write `html.dark .x`.
- **`useColorMode()` at template top level causes hydration mismatches** (SSR has no stored mode). Prefer rendering both variants and toggling with CSS (the `Wordmark.vue` pattern), else defer to `onMounted` with a neutral default, else `<ClientOnly>`.
- **A server-rendered button has no handler until hydration**, which on the lean marketing pages (`useLeanResourceHints`) is well after `load`. A button a visitor clicks first ("Start writing") carries `data-early-click`: `plugins/early-clicks.ts` queues such clicks and replays them once hydrated (`utils/platform/earlyClicks.ts`). Tests wait for `<html data-hydrated>` before clicking one (or click with `toPass`).
- **`data-testid` on `UModal` doesn't reach the DOM**: put it on a wrapper inside `<template #content>`. For dropdown menu items, put it on the rendered `<button>`.
- **Logout is a hard reload** (`useLogout` → `window.location.href = '/'`), never `navigateTo()`; other tabs reload via the BroadcastChannel receiver.
- **Gate every purchase surface on `useBillingMode()`**: upgrade buttons, plan badge and spending → `billingEnabled`; links to `/pricing` → `pricingVisible`; "limit reached" copy uses the `*Free` i18n variants when billing is off. Never point a user at a purchase that doesn't exist.
- **Gate AI entry points on `useAiAvailability()`**: `chatMissing` → "add your API key" link instead of the prompt; `transcriptionAvailable` / `liveDictationAvailable` gate the mic and dictation; `chatPlatformBilled` decides whether an empty AI budget blocks the prompt. `null` (not loaded) keeps the default rendering. Provider mutations (`app/queries/ai.ts`) refresh it themselves.
- **Server state goes through `app/queries/`** (Pinia Colada; [client-data.md](../docs/contributing/client-data.md)). A resource with a query (account status, plan + limits, AI points / availability / providers, saved themes, the workspace list, plan prices) is read through its composable and changed through its mutation, which invalidates every dependent key. Never `apiFetch` / `useFetch` such a resource in a component, and never hold it in `useState`.
- **No cookie banner, no non-essential storage.** Adding any (analytics, replay, cookie-setting embeds) requires a consent purpose and banner first (`app/components/legal/AGENTS.md`), and every new browser storage key must be listed in the privacy policy.
- **Analytics is cookieless and centralised** (`docs/operations-analytics.md`): events and their data only from `shared/analytics/events.ts`, sent through `useAnalytics()` / the plugin; never a third-party script, never content, ids or titles in event data, never a page view of `/d` or `/p`. A new tracked button gets its `data-testid` in `CLICK_TARGETS`, not analytics code in the component.

## Public pages (marketing, docs, legal)

- **Keep logged-out first loads lean.** Pages in `app/layouts/marketing.vue`, `app/layouts/docs.vue`, `/legal/**` and the logged-out `/` call `useLeanResourceHints()`; never call it from an app page. Code a logged-out visitor doesn't need stays in `Lazy*` components (dashboard, new-document dialog, signed-in menu, onboarding overlays).
- **The docs area is English only** (the docs are not translated). A component that can appear on a `/docs/**` page (docs layout and pages, `Flow.vue`, the shared `AuthUserMenu` and `CommonLegalFooter`) takes its texts from `useAreaI18n()`, not `useI18n()` / `$t`; never call `setLocale` there. Moving a docs page needs an entry in `shared/docs/docsRedirects.ts`. See [flow-docs.md](../docs/contributing/flow-docs.md#docs-sections-moved-pages-language).
- **Never import `shared/tour/data` or `shared/tour/schema` from client code** (zod would ship with the home page); use `useTourManifest()`.
- **Load Lenis only through `useTourScroll`** (dynamic import after idle, pinned desktop layout only). Don't hijack wheel input or add `mandatory` snapping.
- **Set `loading="lazy"` before `src`** on client-created `<img>`, or the hidden colour-mode variant downloads.
- **Page titles:** set only the page's own title; the template adds `· markoto`. Use `useMarketingSeo()` on indexable pages. Canonical and Open Graph URLs come from the configured site URL, never the Host header.
- **Hosted-only pages** use `definePageMeta({ middleware: 'marketing-pages' })`. `/pricing` is not hosted-only.
- **Pricing numbers come from live config** (`/api/billing/tiers`, `/api/billing/prices`); never hard-code a price or limit. Planned ("coming soon") prices stay out of the Offer JSON-LD. No `aggregateRating` / `review` in structured data.
- **Marketing copy:** markoto is "source-available", never "open source". German uses "Sie" and "ss" (never `ß`), French "vous". Don't state counts that change (presets, templates). Header links stay short; use-case, comparison and template pages are linked from the footer only.
- **`::sample` / `renderTrustedMarkdown` skip DOMPurify on the server: committed content only, never visitor input.**
- **`::sub-processors` renders the live registry; never retype the sub-processor list in a page.**
- **Comparison facts** live in `content/compare/<slug>.yml` with a source and `checked` date; re-verify at the source before bumping a date.
- **On `/de/…` and `/fr/…` set the vue-i18n locale directly, never `setLocale()`** (it writes the language cookie).
