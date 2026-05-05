# Vue Frontend

Nuxt 4 frontend. Substantive sub-domains have their own AGENTS.md:

- `app/composables/AGENTS.md` — document composables (token, sync, document orchestrator, version-skew, cross-tab logout).
- `app/utils/AGENTS.md` — preview rendering pipeline (paged.js iframe + server-side render path) + markdown comments + editor commands + CDN SRI conventions.
- `app/components/ai/AGENTS.md` — AI presence primitives (Cursor / Tag / GutterMark / Thinking / AIPromptBar / Waveform).
- `app/components/collab/AGENTS.md` — Activity Log (Tier 1 diffs, Tier 2 restore).
- `app/components/document/AGENTS.md` — document context fields + new-doc dialog.
- `app/components/legal/AGENTS.md` — privacy surfaces (onboarding gate, consent banner, deletion modal + grace banner).

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
- **Title Case Headings.** Sentence case only. The brand voice is "Rethinking the *craft* of writing." not "Rethinking The Craft Of Writing".
- **Emoji in product UI.** Lucide outline icons only (1.5px stroke, sumi-toned) — and never sparkles.
- **`text-primary` on a decorative icon or hover state.** Shu is the AI mark. Decorative icons are `text-toned` or `text-muted`. Hover swaps stay sumi.
- **`color="primary"` on a button that isn't invoking markoto.** Use `color="neutral"`.
- **`color="info"` for "look at this" affordances.** Default Nuxt UI info is slate-blue; the brand keeps human-collaborator presence in slate but hates seeing it on alert/CTA surfaces. Use `neutral` (sumi) instead.
- **Saturated avatar palette.** Live awareness colors come from `app/utils/colors.ts` — 15 desaturated paper-aesthetic pastels (sage, ochre, dusty rose, slate blue, mauve, etc.). None get close to shu (humans never wear the AI red).
- **Italic Fraunces in a button or short heading.** Reserved for the AI voice + display emphasis (`<em>` inside Fraunces 300 hero headlines).
- **Two reds on screen meaning different things.** Shu means *AI*. Error red is `error` (rose). They never confuse because shu always sits next to the seal/wordmark and error sits on alert chrome.

### When in doubt

Pick the move that reads as "calm field guide on warm paper". The brand wins by *restraint* — every removed piece of chrome and every dropped weight makes the wordmark + seal land harder.

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
- **`useColorMode()` is SSR-mismatch-prone** — at component top level, it returns 'light' on SSR (no localStorage) and the actual mode on client, causing hydration warnings (and at scale, Suspense hangs). Either: (a) defer to `onMounted` with a neutral default ref; (b) wrap the dependent template chunk in `<ClientOnly>`; (c) render both variants and CSS-toggle (the Wordmark pattern). Prefer (c) > (a) > (b).
- **Cross-component events for legal surfaces.** `markoto:reopen-consent` (footer link or profile-page button → re-opens `ConsentBanner.vue`) and `markoto:consent-updated` (banner → analytics modules listen and (un)mount accordingly). Don't read the consent cookie directly from anywhere except the banner — go through the event so the listeners see the same state transitions in order.
- **`useAccountStatus()` is `useState`-backed** so the four `app/components/legal/*` surfaces (gate, banner, deletion modal, grace banner) see the same reactive snapshot. `refresh()` re-fetches `/api/user/account-status`. Don't add `useFetch` of the same endpoint inside individual components — they'll race.
- **Logout uses `window.location.href = '/'`, not `navigateTo()`.** Soft-navigate leaves stale `useState` keys (avatar + account status) and 401-toast spam from SSR-cached fetches; the cross-tab BroadcastChannel logout receiver also expects a hard refresh. The `useLogout` composable already does the right thing — don't replace it with a soft navigate.
