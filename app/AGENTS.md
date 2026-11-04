# Vue Frontend

Nuxt 4 frontend. Substantive sub-domains have their own AGENTS.md:

- `app/composables/AGENTS.md` — document composables (token, sync, document orchestrator, version-skew, cross-tab logout).
- `app/utils/AGENTS.md` — preview rendering pipeline (paged.js iframe + server-side render path) + markdown comments + editor commands + vendored-asset (SRI) conventions.
- `app/components/ai/AGENTS.md` — AI presence primitives (Cursor / Tag / GutterMark / Thinking / AIPromptBar / Waveform).
- `app/components/collab/AGENTS.md` — Activity Log (Tier 1 diffs, Tier 2 restore).
- `app/components/document/AGENTS.md` — document context fields + new-doc dialog.
- `app/components/legal/AGENTS.md` — privacy surfaces (onboarding gate, deletion modal + grace banner; no cookie banner).

**Where to find things fast:** `make help` (root Makefile) lists every dev/test/deploy target with one-line descriptions. `docs/CHEATSHEET.md` is the human-facing crib sheet for "I forgot which command does X" — keep it in sync when you add a script. For agent-facing structure, the table above + the root `AGENTS.md` index are canonical.

## Design System

The product is **markoto** — a precision writing tool dressed quietly. The brand reads as "workshop instrument", not "developer tool". Every surface in the app should feel like a printed field guide on warm paper, not a kanban-app dashboard.

### The seal IS the AI

The single most load-bearing brand idea: **the small red square (the *seal*) is markoto's AI presence**. It marks where the AI is, where the AI has been, and where the AI is speaking. The seal is the brand mark AND the universal indicator of intelligence in the product. They are the same object.

This collapses two rules that often diverge in design systems:

- The **brand-primary** color (Tailwind `primary`) and the **AI-presence** color are both `shu` (vermillion).
- Therefore: **shu means AI, never CTA.** Primary CTAs are `neutral` (sumi-950 light / sumi-50 dark) — see `app/app.config.ts` button override. If you find yourself reaching for `color="primary"` on a button that isn't invoking the AI (post a comment, save settings, upload a file), use `color="neutral"` instead.

Surfaces that wear the seal:

- The wordmark lockup (in every topbar via `<CommonWordmark>`)
- The AI prompt bar (idle indicator + send button + ring + glow + active pulse)
- The `@markoto` mention pill in comments
- The "AI is responding" indicator on comment threads
- Sponsored `(+)` workspace cards on the dashboard
- The `markoto` workspace tab + AI workspace card
- Activity-feed AI rows (avatar = bone disc + centered seal)
- PresenceBar AI collaborator (same disc + seal)
- Pricing page AI-credits row
- The four AI-presence primitives in `components/ai/`: `Cursor.vue`, `Tag.vue`, `GutterMark.vue`, `Thinking.vue`

If you're tempted to use shu somewhere else, ask: "is this surface invoking, attributing, or representing markoto?" If no, use sumi.

### Tokens

Defined in `app/assets/css/main.css` via Tailwind v4's `@theme static` block. Layer 2 mapping in `app/app.config.ts`.

| Token family | Stops | Role |
|---|---|---|
| `shu-{50..950}` | full ramp, canonical 500 (`#B5371F`) light, 400 (`#D14828`) dark | The seal. AI presence. |
| `sumi-{50..950}` | full ramp, warm gray | Page bg, chrome, text, dividers, hairlines. |
| `--font-sans` | `Inter` | Body, UI labels, buttons, status. Weights **400 + 500 only**. Never 600+. |
| `--font-mono` | `JetBrains Mono` | Eyebrows, meta labels, captions, status colophon, kbd chips, line/char/page counts, timestamps, mention pills. Weight 400. |
| `--font-serif` | `Fraunces` (variable opsz, weights 300–500 + italic) | Wordmark, display headlines, all editorial titles (workspace name, doc title, panel headers, named objects), AI-voice italic moments. |

Nuxt UI v4 surface aliases (Layer 2 — used everywhere via Tailwind utilities like `bg-default`, `bg-muted`, `text-muted`):

| Alias | Light | Dark | Use |
|---|---|---|---|
| `bg-default` | `#fff` (pure white) | sumi-900 | Cards, paper sheets, working surfaces. |
| `bg-muted` | sumi-50 (`#FAF8F4`) | sumi-950 (flat) | Page bg, toolbar, sidebar wrappers, status bar, iframe surround. ONE chrome field across the app. |
| `bg-elevated` | sumi-100 (`#F2EFE7`) | sumi-950 (flat) | Section sub-fields, accordion bodies, hover states. |
| `text-default` | sumi-950 | sumi-100 | Body text. |
| `text-muted` | sumi-400 | sumi-400 | Secondary captions. **NOT** `text-toned` (that's sumi-300, near-invisible against bone). |

Dark-mode-flat sumi-950 is intentional: the canonical lockup SVG (`primary-lockup-dark.svg`) bakes a sumi-950 background rect in for cream-on-dark legibility, so every chrome surface where the lockup lands needs to resolve to sumi-950. The `bg-default` cards stay at sumi-900 so they retain visible contrast against the chrome wrapper.

### The voice / typography ladder

| Role | Font | Size | Weight | Tracking | Where |
|---|---|---|---|---|---|
| Display headline (hero, chapter) | Fraunces | clamp(36px, 5.5vw, 64px) – `text-5xl/6xl` | 300 / 400 | -0.02em | Homepage hero, docs hero, Flow chapters |
| Editorial title | Fraunces | `text-2xl` / `text-3xl` | 400 (`font-normal`) | tracking-tight | Workspace name, doc title in editor, panel headers, "Knowledge base", section h2s |
| Named-object title | Fraunces | `text-base` / `text-lg` | 400 | tracking-tight | Workspace cards, doc list rows, knowledge files, member names, comment-panel header |
| Body | Inter | 14–15px | 400 | 0 | All prose, doc content (`.prose p`) |
| UI label | Inter | 13px | 500 | 0 | Buttons, form labels, navigation |
| Mono micro-label (eyebrow) | JetBrains Mono | 10.5–11px | 400 (`font-normal`) uppercase | 0.06em | Section heads ("TEMPLATES", "DESCRIPTION"), eyebrows ("FIELD GUIDE · VOL. 01"), CTA chips ("BEGIN WALKTHROUGH →") |
| Mono caption / colophon | JetBrains Mono | 10.5px | 400 lowercase | 0.04em | Status bar (`450 words · 2 pages`), comment timestamps, comment Delete/Resolve actions, kbd hints, character counters, file size + chunks, AI-state captions |
| AI italic voice | Fraunces italic | 14–17px | 400 | -0.01em | `<AiThinking>`, the AI prompt bar input itself ("Ask markoto…"), and **only** these places |

Italics are reserved for the AI voice. If you need emphasis in body prose, use `<strong>` (which renders at weight 500 — the brand never goes 600+).

### Brand components

Build new "AI is here" surfaces from these primitives, never from a Lucide sparkles icon:

- `components/common/Wordmark.vue` — the canonical lockup. Renders both light + dark SVG variants in the same DOM with CSS-driven color-mode swap (no JS src swap → no hydration mismatch). Always-on tracking-tight, font-serif. Pixel-perfect from first paint (text outlined to paths).
- `components/common/Seal.vue` — the square shu hanko, 2px corner radius, CSS shape (`background: var(--color-shu-500)`). Drop in anywhere "the AI is here" — `<CommonSeal :size="9">`. Light: shu-500. Dark: shu-400.
- `components/ai/Cursor.vue`, `Tag.vue`, `GutterMark.vue`, `Thinking.vue` — the four in-document AI primitives.

The lucide `i-lucide-sparkles` icon is **banned in user-facing chrome**. If you're representing AI, use `<CommonSeal>`. If `i-lucide-sparkles` shows up in a code review, push back.

### Active-state vocabulary

The app has one and only one "AI is working" animation: a single-color shu pulse on a fixed shadow (`@keyframes mk-pulse` family). Used in:

- `AIPromptBar.vue` `.is-active` shell
- `CommentThread.vue` `.comment-thread-card.is-ai-active`

If you need to indicate "this surface is alive, the AI is doing something here", reuse the same keyframe vocabulary. **Do not introduce a rainbow `hsl(...)` cycle, a violet/blue gradient, or a sparkles spin.** Earlier iterations of these surfaces all wore rainbows; they were ripped out because they violated the seal-only rule.

### What kills the brand (lifted from the design doc, pinned here)

If any of these show up, fix them:

- **Bright Tailwind primaries** anywhere (`bg-blue-500`, `text-amber-500`, `bg-violet-500`, etc.). Sweep `-blue-` / `-amber-` / `-violet-` / `-orange-` periodically; the only legitimate hits are `text-shu-*` / `text-sumi-*` / `text-green-*` for genuine `success` semantics + `text-rose-*` for `error`.
- **Pure white backgrounds (`#fff` everywhere) or pure black text.** Use `bg-default` / `text-default` — they resolve to the right warm/cool stops per mode.
- **Drop shadows on cards.** Use background shifts (`bg-default` cards on `bg-muted` chrome). Never `shadow-md` to "lift" a card.
- **Bold weights (600+) in chrome.** Stay at 400 / 500. `font-semibold` and `font-bold` should not appear outside very narrow code-fence labels.
- **Title Case Headings.** Sentence case only. The brand voice is "Beautifully rendered *Markdown*." not "Beautifully Rendered Markdown".
- **Emoji in product UI.** Lucide outline icons only (1.5px stroke, sumi-toned) — and never sparkles.
- **`text-primary` on a decorative icon or hover state.** Shu is the AI mark. Decorative icons are `text-toned` or `text-muted`. Hover swaps stay sumi.
- **`color="primary"` on a button that isn't invoking markoto.** Use `color="neutral"`.
- **`color="info"` for "look at this" affordances.** Default Nuxt UI info is slate-blue; the brand keeps human-collaborator presence in slate but hates seeing it on alert/CTA surfaces. Use `neutral` (sumi) instead.
- **Saturated avatar palette.** Live awareness colors come from `app/utils/colors.ts` — 15 desaturated paper-aesthetic pastels (sage, ochre, dusty rose, slate blue, mauve, etc.). None get close to shu (humans never wear the AI red).
- **Italic Fraunces in a button or short heading.** Reserved for the AI voice + display emphasis (`<em>` inside Fraunces 300 hero headlines).
- **Two reds on screen meaning different things.** Shu means *AI*. Error red is `error` (rose). They never confuse because shu always sits next to the seal/wordmark and error sits on alert chrome.

### User avatars

Every person is a DiceBear **Moods** face (CC0) drawn locally — never a GitHub/Google/OIDC picture (not stored since v0.4.1; migration 0026 nulled `users.avatar_url`, 0027 dropped the column; loading them would hand viewers' IPs to the provider) and never api.dicebear.com. One component: `<CommonUserAvatar :seed :name :size>` (`components/common/UserAvatar.vue`). Seeds via `avatarSeedFor()` (`utils/userAvatar.ts`): signed-in → `u-<id>` (same face everywhere), anonymous → `a-<token>` where the token is random per tab (`markoto-anon-avatar` in sessionStorage, broadcast as awareness `user.avatarSeed`, stored on the visitor's comments as `authorAvatarSeed` and on their activity-log rows as `actor_avatar_seed`). Positive moods only (curated eye/mouth allow-list — Moods 10.6 has no mood tags), background from the `utils/colors.ts` pastels with a lighter face tint, sumi-950 ink, blink animation that the SVG itself switches off under `prefers-reduced-motion`. The renderer (`utils/userAvatarRender.ts`, `@dicebear/core` ≈ 45 KB gzip) is lazy-loaded; SSR + hydration show the seed's background disc and the face appears after mount. The AI never uses it — it keeps the seal disc.

### When in doubt

Pick the move that reads as "calm field guide on warm paper". The brand wins by *restraint* — every removed piece of chrome and every dropped weight makes the wordmark + seal land harder.

## Product page (`components/landing/`, WP11)

Logged-out visitors on an instance with `NUXT_MARKETING_SITE_ENABLED` (hosted only; `useInstanceConfig().marketingSite`; the former `NUXT_PRODUCT_TOUR_ENABLED` is read as an alias for one release) see `LandingProductTour` at `/` instead of the plain hero; signed-in users keep the dashboard. Each scene's picture is a short looping video (AV1 + H.264, light + dark, desktop + phone cut, poster) recorded from the real app by `bun run tour:capture` (see `tests/e2e/AGENTS.md`); assets + metadata in `public/tour/manifest.json`.

CSS first: one sticky stage window (desktop ≥ 1024px with `animation-timeline` support, no reduced motion) — it travels from under the hero to its place on a `scroll()` timeline, alternates sides per scene (keyframes generated by `shared/tour/manifest.ts#stageSideKeyframes` on the track's view timeline), cross-fades scene layers and copy on each section's named view timeline (`timeline-scope` on the track), and fades out before the closing section. Elsewhere: a static layout (alternating columns on desktop, copy beside the picture on landscape phones, stacked copy-then-picture on phones). Phones show the WHOLE window (desktop media, 16:10, contained) — the manifest's phone cuts (focus crops) cut through the editor and the pages; `TourVisual`'s `phoneCut` prop switches them back on. Keep `loading="lazy"` BEFORE `src` on any client-created `<img>` — otherwise the hidden color-mode variant downloads. The tour's CSS still reserves `var(--mk-consent-h, 0px)` at the bottom for a cookie bar; there is none today (essential storage only), so it resolves to 0. A future bottom bar should publish its height under that name.

JS, and why: lazy-mounting far-away stage scenes; playing the on-stage video (`TourVisual.vue`: `preload="none"`, IntersectionObserver, reduced motion → poster only); the pager; the colour phase; the PDF fan-out.

**One rest per scene, paged.** CSS scroll snapping (only while `.mk-tour-page` is on the page — `html:has(.mk-tour-page)`): one rest per scene at the middle of its window (`SNAP_REST_T`, a 1px `.mk-snap--scene` marker placed by `restOffsetVh`; a snap area taller than the viewport would let the browser stop anywhere inside it); the page header is the hero rest, the page end the last. On the pinned layout (`mandatory` + `scroll-snap-stop: always`) `app/composables/useTourPager.ts` pages it: every wheel/trackpad gesture and every PageUp/PageDown/Space/arrow/Home/End is ONE glide to the next rest, `GLIDE_MS` (≈1 s) ease-in-out, with snapping switched off during the glide, so the scroll-tied copy fade, stage slide and colour flip play out between rests. Gesture rules (`shared/tour/paging.ts#wheelSteps`, unit-tested): a run of notches or a trackpad flick incl. its momentum tail (even one that outlasts the glide or stalls) = one step; a gesture that starts mid-glide is swallowed. It fires `mk-tour:rest` / `mk-tour:depart` on `window`. **Next buttons:** "See how it works ↓" beside the hero CTA and a round ↓ under every scene but the last (`goToScene` in ProductTour: pinned layout → `pager.goTo(rest)`, a glide; elsewhere `scrollIntoView({ block: 'center' })`, `auto` under reduced motion). The pinned copy carries its own (`.mk-next--pinned`, fades with the copy); static layouts show the one under the picture (`.mk-next--static`). Scrollbar drags and touch keep native snapping. Phones, Firefox's static layout, reduced motion: `proximity` on the scene sections, no pager; `scroll-behavior: auto` under reduced motion.

**Light → dark flip, every engine.** The page root (`.mk-tour-page`, set in `pages/index.vue`) starts light whatever the OS prefers; `useTourTone().dark` (set by ProductTour from the scroll position — the scene named by `TOUR_DARK_FROM` in `shared/tour/config.ts` past the middle of the viewport) adds `is-dark`, and the `@property`-registered colour tokens transition (~0.7 s; instant with reduced motion). No scroll-driven animation is involved, so Firefox and older Safari flip too. Nuxt UI's `--ui-*` surface vars are mapped onto the tokens inside the page (the header turns too); each visual shows its `tone`'s media (`light` / `dark` / `flip` = both, cross-faded on `--mk-dark`). The header shows a page-local toggle instead of `UColorModeButton`: it reflects what is on screen and, when clicked, fixes that mode for the rest of the visit (`useTourTone().mode`) and stores it for the app. **A colour mode stored earlier never disables the flip** — Nuxt's toggle only ever stores light/dark, so one old click would kill it forever. The global colour mode is otherwise untouched.

**PDF fan-out** (share scene): part of the scene's rest state — `TourVisual` opens it ~1.6 s after `mk-tour:rest` for that scene (the share dialog in the video is seen first), closes on `mk-tour:depart`; inline (phones / static) when the figure is ≥ 60 % in view. CSS transitions, staggered per page; reduced motion shows it fanned.

**Copy:** `tour.*` in all six locales — plain and concrete for people who already want a Markdown editor; no slogans, nothing the product doesn't do (seven theme presets: `shared/utils/themePresets.ts`). `<div class="mk-tour" :lang>` carries the locale so Japanese/Chinese headings break at phrases (`word-break: auto-phrase`).

## SEO (`shared/seo/`, SEO-1)

- **Title template** `%s · markoto` (`app.vue`, `shared/seo/meta.ts#applyTitleTemplate`). Pages set ONLY their own title — never append the brand; no title = "markoto — Collaborative Markdown". The home page uses that default untemplated (`useMarketingSeo({ bareTitle: true })`).
- **`useMarketingSeo({ title, description, image? })`** on every indexable page (`/`, `/pricing`, `/docs/**`): description, og:title/description/type/site_name/url/image, twitter:card. og:url + og:image are absolute from `NUXT_SITE_URL` (`useInstanceConfig().siteUrl`) or left out. Default card: `public/og/markoto.jpg` (1200×630, `scripts/build-og-image.sh` from a tour poster; JPEG on purpose).
- **Canonical:** `useCanonical()` in `app.vue` for every route (`shared/seo/paths.ts#canonicalUrl`): site URL + path, no query, none for `/d/**` or without a site URL; `/docs/**` off the marketing site → `docsCanonicalBase` (markoto.app, `NUXT_DOCS_CANONICAL_BASE`). Never the Host header.
- **`<html lang>`** follows the active i18n locale.
- **JSON-LD** (`useHomeStructuredData`, `shared/seo/structuredData.ts`): `/` on the marketing site only — Organization (operator from `InstanceConfig.operatorName`) + WebSite + SoftwareApplication (free). Never ratings/reviews. `application/ld+json` is a data block, so the CSP's `script-src` doesn't apply; `<` is escaped.
- **Hosted-only pages:** `definePageMeta({ middleware: 'marketing-pages' })` → 404 unless `marketingSite`.
- **Server side:** `server/routes/sitemap.xml.ts` (marketing site + site URL only; `server/utils/sitemap.ts`, `marketingSitemapPages()` is the hook for localised pages with hreflang), `robots.txt` adds `Sitemap:` there; `NUXT_SITE_INDEXABLE=false` (staging) → `Disallow: /` + `X-Robots-Tag: noindex` on every response (`server/plugins/robots.ts`).
- `tests/unit/seoMetaLengths.test.ts` pins title ≤ 60 (with suffix) and description ≤ 160 for docs + marketing frontmatter and the `/` + `/pricing` strings in every locale.

## Marketing pages (SEO-2)

- **Shell:** `components/marketing/Header.vue` is the header of `/` (all states; the tour passes its tone toggle through the `#mode` slot and the root stays `header:first-child` for the tour's snapping) and of `layouts/marketing.vue` (`/pricing` + content pages; adds `MarketingStartButton`, ground `bg-muted` like the home page). Links: Pricing (`pricingVisible`), Use cases / Compare menus (from content, hidden while empty), Self-host, Docs — the marketing ones only on the marketing site and only for logged-out visitors; inline from `lg`, one Menu dropdown below. `CommonLegalFooter` gained a site row (Pricing, Self-host, the menu pages). `/pricing` is NOT behind `marketing-pages` — self-hosted instances show their limits there.
- **Content:** `content/marketing/<locale>/<slug>.md`, collection `marketing` (`content.config.ts`: title, description, ogImage?, keywords, updated, `reviewed` (default true), `navGroup`/`navLabel`/`navOrder`). Rendered by `pages/[...marketing].vue` (catch-all, so also the 404 for every unknown path; `marketing-pages` middleware; lookup `utils/marketingPage.ts`). Rules in `shared/seo/marketing.ts`: en at `/<slug>`, de/fr at `/<locale>/<slug>`; hreflang (`en`, `de`, `fr`, `x-default`) only for versions that exist AND are reviewed; `reviewed: false` → `noindex, follow`, a notice, no hreflang, not in the sitemap (`server/utils/sitemap.ts#marketingSitemapPages`).
- **UI language on `/de/…`, `/fr/…`** follows the URL (`plugins/marketing-locale.ts`): sets the vue-i18n locale directly — never `setLocale()`, which writes the `ypad_locale` cookie — and restores the previous language on the first navigation to an unprefixed route. Everything else stays `no_prefix` + cookie.
- **MDC blocks** (`components/content/`): `::cta` (new-document dialog), `::flow-strip{id frames caption?}` (flow screenshots; `caption` replaces the step text of a single shot; manifests bundled via `import.meta.glob`, SSR `<img>` light + dark CSS-toggled), `::tour-clip{scene}` (tour poster + muted loop of the visible mode), `::faq` (props `items: [{q, a}]`, optional `json-ld` → FAQPage), `::sample{kind}` with a YAML `source:` (rendered on the server by `renderTrustedMarkdown` — the preview pipeline WITHOUT DOMPurify on the server, so committed content only, never user input; `kind` = `commonmark` / `gfm` / `markoto`), `::compare-table` (`columns`, `rows[{label, values, note?}]`, `true`/`false`/`partial`/text). Wide blocks opt out of the 72ch column with `.mk-wide`.
- **Comparison pages (SEO-6):** `/compare` (hub, `content/marketing/en/compare/index.md`) + `/compare/<slug>`. Competitor facts live in `content/compare/<slug>.yml` (data collection `compare`): per row a markoto and a competitor claim `{value, source, checked}` (competitor source = https URL, markoto source = docs/legal page or repo path). `::compare-facts{competitor}` renders the table (via `::compare-table`, which scrolls in its own box with a sticky feature column on phones), `::compare-sources{competitor}` the "Facts checked on …" footer + trademark note; helpers in `shared/seo/compare.ts`. `tests/unit/compareClaims.test.ts` fails when any `checked` is older than 9 months: re-verify at the source, then bump the date. Every page keeps a "Where <competitor> is better" section, and markoto's gaps (no slides, Git sync, citations, suggestions, offline, E2EE; not OSI open source) stay stated where relevant.
- Licence wording on marketing pages: "source-available", never "open source".

## Mobile

Breakpoint: `useMediaQuery('(max-width: 639px)')` — matches Tailwind `sm:`. Don't reintroduce 768px.

- Edit-only default on narrow; `watchEffect` forces `viewMode = 'edit'` when `isMobile && viewMode === 'split'`.
- CM6 responsive theme via Compartment: 16px font (prevents iOS auto-zoom), 1.7 line-height, reconfigured on resize.
- `autocapitalize: 'sentences'`, `autocorrect: 'on'`, `spellcheck: 'true'` always on.
- Toolbar `flex-wrap`, collapsed hamburger menu, icon-only connection badge, responsive title.
- Right sidebar: `< xl` (≤1279px) — opening panel hides preview; `xl+` — fixed `w-80` sidebar, genuine triple-pane. Preview uses `hidden xl:block` (CSS), not `v-if`, so resize past xl restores it without remounting.
- Mobile sprint additions: bottom-sheet pattern for sidebar panels on `< sm`, mobile format bar (subset of toolbar) docked above the keyboard via `position: sticky`, view-mode bar (Edit / Preview) replacing the desktop split toggle. Don't reach for `visualViewport` API yet — Safari iOS behaviour is inconsistent and tracked under "Mobile MMP" in the root TODO list.

## Common Vue conventions

- **CM6 `readOnly` must go through Compartments** — `isReadOnly` is async-set after `fetchToken`.
- **Single Awareness instance** — create in orchestrator, pass to both `HocuspocusProvider` and yCollab.
- **Y.js Map reactivity** — `ymeta.get('title')` isn't Vue-reactive; use `ymeta.observe()` → ref + computed.
- **Mobile breakpoint: 639px** — matches Tailwind `sm:`. Don't reintroduce 768px.
- **Literal `@` in i18n locale JSON** — `@:key` is parsed as a linked message. Escape with `{'@'}` or reword to avoid `@` in string literals.
- **`@nuxtjs/i18n` v10:** `lazy` removed — lazy is default when `locales[].file` is set. `langDir: 'locales/'` resolves relative to `i18n/`, not `app/`.
- **i18n new top-level keys require a dev-server restart**, not just HMR. HMR for existing keys works; adding a new namespace shows literal-key strings until restart.
- **Never write `:global(.dark) .x` in a scoped style.** Vue drops everything after `:global(...)`, so it compiles to a bare `.dark { … }` that styles `<html>` itself (Seal.vue's version painted the whole page canvas shu in dark mode). Write `html.dark .x` instead; scoped CSS keeps it as an ancestor selector. All components are fixed now (the broken form also painted the page canvas shu in dark mode — that is now the deliberate overscroll colour in `main.css`: shu-400 dark, sumi-950 light).
- **`useColorMode()` is SSR-mismatch-prone** — at component top level, it returns 'light' on SSR (no localStorage) and the actual mode on client, causing hydration warnings (and at scale, Suspense hangs). Either: (a) defer to `onMounted` with a neutral default ref; (b) wrap the dependent template chunk in `<ClientOnly>`; (c) render both variants and CSS-toggle (the Wordmark pattern). Prefer (c) > (a) > (b).
- **No cookie banner.** markoto uses only strictly necessary storage (privacy §9), so there is no consent banner and no `markoto:reopen-consent` / `markoto:consent-updated` events any more. The footer carries `legal.footer.cookieNote`, the profile page `settings.profile.legal.cookieNote`. Adding any non-essential storage (analytics, replay, third-party embeds that set cookies) requires a consent purpose + banner first — see root AGENTS.md §4.
- **Billing mode on the client: `useBillingMode()`** → `billingEnabled`, `plansComingSoon`, `pricingVisible`. SSR-hydrated `useState('billing-mode')`, resolved on the server from the same env parser the API guards use (`shared/config/billingMode.ts`); `app/plugins/billing-mode.ts` touches it on every SSR pass. Gate every purchase surface on it: upgrade buttons / plan badge / profile spending section / workspace AI (`(+)`) tab + banner + seal → `billingEnabled`; links to `/pricing` → `pricingVisible`; "limit reached" copy uses the `*Free` i18n variants + `billing.comingSoonHint` when billing is off. Never point a user at a purchase that doesn't exist. The AI-points meter (`UsageBadge`) stays in every mode — the monthly budget is real either way.
- **AI availability on the client: `useAiAvailability()`** (bring your own key, WP4) → `useState('ai-availability')` from `GET /api/ai/availability`. `chatMissing` swaps the AIPromptBar input for a "Add your API key in Settings" link (and `CommentsPanel` toasts the same instead of firing `@ai`); `transcriptionAvailable` gates the voice-prompt mic; `liveDictationAvailable` gates the toolbar / mobile dictation button; `chatPlatformBilled` decides whether an empty AI Points budget blocks the prompt bar; `anyPlatformBilled` decides whether `UsageBadge` shows at all. Null (not loaded yet) = keep the pre-BYOK rendering, so nothing flashes. Settings live at `/settings/ai` (`AI_SETTINGS_ROUTE`, `components/settings/AiProviderCard.vue`); call `refresh()` after saving/removing a provider.
- **`useAccountStatus()` is `useState`-backed** so the four `app/components/legal/*` surfaces (gate, banner, deletion modal, grace banner) see the same reactive snapshot. `refresh()` re-fetches `/api/user/account-status`. Don't add `useFetch` of the same endpoint inside individual components — they'll race.
- **Logout uses `window.location.href = '/'`, not `navigateTo()`.** Soft-navigate leaves stale `useState` keys (avatar + account status) and 401-toast spam from SSR-cached fetches; the cross-tab BroadcastChannel logout receiver also expects a hard refresh. The `useLogout` composable already does the right thing — don't replace it with a soft navigate.
