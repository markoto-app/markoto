# Vue Frontend

Nuxt 4 frontend. Substantive sub-domains have their own AGENTS.md:

- `app/composables/AGENTS.md` — document composables (token, sync, document orchestrator).
- `app/utils/AGENTS.md` — preview rendering pipeline + markdown comments + editor commands.
- `app/components/collab/AGENTS.md` — Activity Log (Tier 1 diffs, Tier 2 restore).
- `app/components/document/AGENTS.md` — document context fields + new-doc dialog.

## Mobile

Breakpoint: `useMediaQuery('(max-width: 639px)')` — matches Tailwind `sm:`. Don't reintroduce 768px.

- Edit-only default on narrow; `watchEffect` forces `viewMode = 'edit'` when `isMobile && viewMode === 'split'`.
- CM6 responsive theme via Compartment: 16px font (prevents iOS auto-zoom), 1.7 line-height, reconfigured on resize.
- `autocapitalize: 'sentences'`, `autocorrect: 'on'`, `spellcheck: 'true'` always on.
- Toolbar `flex-wrap`, collapsed hamburger menu, icon-only connection badge, responsive title.
- Right sidebar: `< xl` (≤1279px) — opening panel hides preview; `xl+` — fixed `w-80` sidebar, genuine triple-pane. Preview uses `hidden xl:block` (CSS), not `v-if`, so resize past xl restores it without remounting.

## Common Vue conventions

- **CM6 `readOnly` must go through Compartments** — `isReadOnly` is async-set after `fetchToken`.
- **Single Awareness instance** — create in orchestrator, pass to both `HocuspocusProvider` and yCollab.
- **Y.js Map reactivity** — `ymeta.get('title')` isn't Vue-reactive; use `ymeta.observe()` → ref + computed.
- **Mobile breakpoint: 639px** — matches Tailwind `sm:`. Don't reintroduce 768px.
- **Literal `@` in i18n locale JSON** — `@:key` is parsed as a linked message. Escape with `{'@'}` or reword to avoid `@` in string literals.
- **`@nuxtjs/i18n` v10:** `lazy` removed — lazy is default when `locales[].file` is set. `langDir: 'locales/'` resolves relative to `i18n/`, not `app/`.
- **i18n new top-level keys require a dev-server restart**, not just HMR. HMR for existing keys works; adding a new namespace shows literal-key strings until restart.
