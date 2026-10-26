# Flow Docs System

End-to-end pipeline that turns Playwright tests into a documentation site. Each flow IS a test (asserts real product behaviour) AND a tutorial (renders as a slideshow with subtitles, browser chrome, animated cursor, pulsating highlight callouts). The same artefacts power both.

## Pipeline at a glance

```
tests/e2e/flows/<slug>.spec.ts           ← Playwright test using `flow` + `editor` fixtures
        │
        ▼  bun run flows:test  (hermetic — brings up infra + prod build)
        │  (or flows:test:against-running for an already-running app)
        │
tests/e2e/output/flows/<slug>/<locale>/<variant>/
  ├─ manifest.json        ← entry list (heading/narrate/shot), per-shot cursor + path + highlights
  └─ NN.png               ← screenshots, deduped by content hash
        │
        ▼  bun run flows:build
        │
public/flows/<slug>/<locale>/<variant>/  ← same shape, published statically
        │
        ▼  via $fetch in <Flow> at SSR time
        │
content/docs/.../page.md  ::flow{id="<slug>" mode="slides"}::
        │
        ▼  rendered by app/pages/docs/[...slug].vue
        │
docs site
```

## The fixture API (`tests/e2e/fixtures/flow.ts`)

A flow test pulls in `flow` (the recorder) and `editor` (the page-object + setup helpers):

```ts
test('Quick share', async ({ flow, editor }) => {
  await editor.recordPreamble()           // 2 captured shots: open homepage → click New Document
  await flow.heading('Name your document', 3)
  await flow.narrate('...')
  await flow.click('Click the title to rename', editor.page.titleButton)
  await flow.step('Type and Enter', () => editor.page.commitTitleEdit('My doc'))
  await flow.shot('Highlights demo', { highlights: [{label: 'Word count', selector: '...'}] })
})
```

- **`flow.step(caption, action, opts?)`** — runs `action`, then captures. Right when the action target IS the screenshot target (typing into a focused input).
- **`flow.click(caption, locator, opts?)`** — `locator.hover()` → screenshot (cursor visibly on target) → `locator.click()`. Right for click-then-navigate steps where capturing AFTER the click would land on the destination page with a stale cursor.
- **`flow.hover(caption, locator, opts?)`** — same as click but without the trailing click.
- **`flow.shot(caption, opts?)`** — screenshot WITHOUT an action.
- **`flow.narrate(text)`** — prose between shots.
- **`flow.heading(text, level?)`** — section break (## or ###).
- **`flow.skipNext()`** — suppress the next auto-screenshot (transient mid-fade states).
- **`flow.next({ slug, why })`** — set the "Try next" link rendered after the last slide. Hand-curated forward-route to keep readers in the docs. `why` is one short user-voice sentence ("post a comment on a passage your collaborator just wrote"). Call once per flow; later calls overwrite.
- **`opts.highlights: [{ label, selector }, ...]`** — pulsating orange callouts on a shot. Used for OUTCOME-anchoring ("look at this thing that just appeared"). Selector is resolved to a bounding box AT screenshot time. Strict mode (`FLOW_STRICT=1` or `CI=true`) fails when a selector resolves to nothing; local dev keeps a soft warning.
- **`opts.annotations: [{ label, selector, kind? }, ...]`** — DIRECTION-anchoring callouts on the APPROACH frame (the click target). Use this when the target is non-obvious — a small lock icon, a panel-picker dropdown, a typeahead entry. Three render kinds:
  - `'arrow'` (default) — labelled SVG arrow from a slide corner pointing AT the target. Best when the target is small or peripheral.
  - `'box'` — static dashed shu outline around the target with an adjacent label. Best when the target is a clearly-bounded UI region (a card, a panel section).
  - `'pin'` — small numbered shu disc at the top-left of the target. Best when chaining numbered annotations across multiple targets in one shot.
  Pass on `flow.click(...)` opts to anchor the APPROACH frame; pass on `flow.shot/step/type/hover` opts to anchor that frame directly.
- **`opts.hero: true`** — mark this OUTCOME frame as the flow's hero. Rendered above the slideshow as a "what success looks like" preview. At most one hero per flow; the first marked frame wins. Set on the most decisive outcome (a copied link, an AI's reply landed, a finished cover page).
- **`editor.recordPreamble()`** — lean two-step preamble (open → click) for flows where doc creation IS the story. After capture, silently switches to split view.
- **`editor.silentSetup()`** — same setup, but writes nothing to the manifest. For flows where the editor is just setup.
- **`editor.page`** — `EditorPage` instance with stable selectors and composite helpers.

## Captioning rules (read these before writing a flow)

Flows are documentation for end users, not implementation logs. Mistakes here erode trust faster than UI bugs.

- **User voice only.** No "Hocuspocus", no "the editor mounts", no "the read-only flag resolves".
- **Cut steps that don't move the user toward their job.** "Switch to split view" only matters if THIS flow is teaching split view.
- **End every flow at a tangible outcome.** A copied link. A PDF on disk. A password-gated URL. Not "the editor is in split view".
- **Each flow IS a test.** Every step has an assertion behind it.

## Manifest shape

Per-locale + per-variant; one manifest per `(slug, locale, variant)` triple:

```json
{
  "version": 2,
  "title": "Quick share",
  "slug": "quick-share",
  "locale": "en",
  "variant": "light-desktop",
  "viewport": { "w": 1280, "h": 800 },
  "entries": [
    { "kind": "chapter", "level": 3, "text": "Name your document" },
    { "kind": "narration", "text": "Documents start untitled...", "file": "01.webp", "cursor": null, "path": "/" },
    {
      "kind": "approach",
      "file": "02.webp",
      "caption": "Click the placeholder title to rename it",
      "cursor": { "x": 129, "y": 24 },
      "path": "/d/abc",
      "annotations": [{ "label": "title", "kind": "arrow", "x": 100, "y": 16, "w": 200, "h": 28 }]
    },
    {
      "kind": "outcome",
      "file": "03.webp",
      "caption": "The title is set",
      "cursor": { "x": 129, "y": 24 },
      "path": "/d/abc",
      "highlights": [{ "label": "Word count", "x": 16, "y": 760, "w": 80, "h": 18 }],
      "hero": true
    }
  ],
  "next": { "slug": "discuss-with-comments", "why": "Now invite a teammate to react inline" }
}
```

## Capture semantics

- **Cursor injection** (`addInitScript`): tracks `mousemove`/`pointermove` AND the URL pathname at the time of motion. `readCursor` returns null when the path has changed since the last motion (SPA-nav staleness).
- **Path** captured via `new URL(page.url()).pathname` per shot. Powers the fake browser-chrome address bar in `<FlowFrame>`.
- **Highlights**: each ref is resolved via `page.locator(sel).first().boundingBox()`. Renders as a pulsating orange box-shadow.
- **Variant** comes from `testInfo.project.metadata.variant`. The fixture pre-seeds `nuxt-color-mode` localStorage via `addInitScript` in addition to project-level `colorScheme`.
- **Content-hash dedup**: each screenshot's bytes are SHA-256'd. If they match a previous shot in the same run, the new file isn't written and the manifest entry points at the existing PNG.
- **Nuxt devtools chrome stripped** via fixture-side CSS injection (`#nuxt-devtools-container { display: none !important }`).

## Playwright projects (`playwright.config.ts`)

One project per `(locale, variant)` pair. Currently `en-light` + `en-dark`. Each project sets `colorScheme`, viewport (1280×800), and `metadata: { locale, variant }` for the fixture to read. Adding a locale = duplicate both blocks.

Clipboard permissions are pre-granted globally in `use.permissions: ['clipboard-read', 'clipboard-write']` so flows can assert `navigator.clipboard.readText()` for share-link outcomes.

## Build + serve

`scripts/build-flows.ts` does a clean rebuild of `public/flows/` from `tests/e2e/output/flows/` (deletes everything first, then copies — stale flows whose tests no longer exist get reaped). Walks `<slug>/<locale>/<variant>/` recursively; only copies `manifest.json` + `*.png`.

The `<Flow>` component (`app/components/content/Flow.vue`) fetches the manifest using `useRequestURL().origin`-prefixed URLs so SSR works. Variant resolution: subscribes to `useColorMode().value`, picks the matching manifest with a 4-step fallback chain.

## Ephemeral test stack

Lives in `docker-compose.test.yml` under `profiles: [flows]` — adds `sync-test` + `markitdown-test` to the integration-test infra, all on isolated ports (5433/6380/8334/4002/8081). Integration runs (`docker compose up`) skip the flow-only services; flow runs (`--profile flows`) include them.

Lifecycle: `bun run flows:test` (`scripts/flows-ephemeral.ts`) does docker-up → `bun run build` (production Nitro output to `.output/`) → spawn the prod server on PORT=3001 → poll `/api/health` → run Playwright → cleanup on every exit path. Cleanup deliberately does NOT use `--remove-orphans` because that flag treats other compose files in the same project namespace as orphans and would nuke dev infra. The lower-level `flows:test:against-running` skips the build + serve.

## CI integration

The `test-repos-integration-flows` job in `.github/workflows/ci.yml` runs the same `bun run flows:test` against the PR commit on every PR. It brings up `docker-compose.test.yml --profile flows` with `--wait` (compose-level health-gating, not just docker-level), runs the integration repos test suites in the same job, then runs the Playwright flow tests. PR merge is blocked on this check passing — flows are first-class regression tests, not optional eye-candy. See `docs/GITHUB-CONFIG.md` for branch-protection wiring.

## Two-context flows (`flow.spawn`)

`flow.spawn(actorLabel: string)` opens a fresh `BrowserContext` (clean cookies + storage = independent identity), wires the same init scripts the primary page got (cursor tracking, devtools-chrome strip, color-mode preseed), and returns `{ flow, page, editor }` for the new actor. Frames captured from the spawned actor's flow are **interleaved into the same manifest** as the primary's, with an `actor: <label>` field stamped per entry. The renderer ignores the field today; future visual treatment (e.g. a "AS: visitor" chip in the browser chrome) can read it without a schema bump.

Cleanup is automatic — every spawned context is closed at fixture teardown. Hero state and the next-link are shared across all actors (first hero wins; last `next()` call wins).

Use it for two-context stories where one actor's actions visibly affect another's view: owner sets a password → visitor (separate identity) hits the doc URL and sees the password modal. The single-context cookie-clear pattern that preceded `flow.spawn` is honest but loses the narrative beat ("now switch to a fresh browser") — `spawn` makes the switch literal AND lets each actor's JWT lifecycle behave independently.

```ts
test('Password protect', async ({ page, flow, editor }) => {
  await editor.silentSetup()
  // ... owner sets passphrase via Share modal ...

  const visitor = await flow.spawn('visitor')
  await visitor.page.goto(docUrl)
  await visitor.flow.type('Type the passphrase', visitor.page.locator('input[type="password"]'), 'open-sesame', {
    result: '...'
  })
  await visitor.flow.click('Click "Unlock"', visitor.page.getByRole('button', { name: /unlock/i }), {
    hero: true,
    result: '...'
  })
})
```

## Tier-1 flows

All nine Tier-1 flows shipped:

- **`quick-share`** — anon doc creation → name + describe → pick template → share by URL.
- **`discuss-with-comments`** (slug: `have-a-discussion`) — highlight, comment, reply, resolve.
- **`pick-a-theme`** — open theme panel → switch presets → toggle cover (desktop only — mobile skipped because half the visual story is the live preview iframe, which mobile hides).
- **`ai-prompt-bar`** (slug: `write-with-ai`) — focus prompt bar → ask AI to extend the doc → AI's edits stream into the editor.
- **`ai-comment-mention`** (slug: `summon-ai-from-a-comment`) — `@markoto` typeahead → post comment → AI replies on the same thread.
- **`polished-pdf`** — pick the academic preset → File → Save as PDF (desktop only — menubar hidden on mobile).
- **`import-existing`** (slug: `import-existing-document`) — File → Import → drop HTML/DOCX/PDF/PPTX → markitdown converts → Replace welcome content (desktop only).
- **`rich-content`** — Insert menu → code block + alert + KaTeX math + Mermaid pie (desktop only).
- **`password-protect`** — switch access mode → set passphrase → spawn a visitor (`flow.spawn('visitor')`) in a fresh `BrowserContext` → visitor hits PasswordModal → unlock. Hero is the visitor's unlocked outcome, latched across actors.

All carry hero strips (the most decisive outcome rendered above the slideshow), direction-anchoring annotations on key click targets, and a curated `flow.next({ slug, why })` forward link rendered as a "Try next" card after the controls.

## Tier-2 flows

Three Tier-2 flows shipped, demonstrating features that score high on "users would love but never discover on their own":

- **`voice-dictate`** (slug: `speak-instead-of-typing`) — toolbar mic → live dictation streams text into the editor as it's spoken. Pipeline: `MediaRecorder` + audio worklet → WebSocket `/api/ai/dictate` → Mistral Voxtral Realtime → CM6 ghost-text widget → Y.js commit with `dictation:{userId}` origin. Test uses the canned-fake STT mock (`NUXT_GOOGLE_SPEECH_MOCK=1` — env-name retained for compat) plus Chromium's `--use-fake-device-for-media-stream` so the synthetic 16 kHz tone produces the chunk count the mock counts to fire its predetermined "how are you" final transcript. Works on desktop and mobile.
- **`document-context`** (slug: `tell-the-ai-who-you-re-writing-for`) — open the Document tab → set Description + Audience=Marketing + Language=Deutsch → ask the AI for an intro. The AI returns marketing-tone Deutsch without the prompt mentioning audience or language. Live Mistral call via LiteLLM. Works on desktop and mobile (Phase 6.5+).
- **`knowledge-rag`** (slug: `knowledge-grounded-ai`) — workspace setup → upload Q3 postmortem HTML → wait for ready → create new doc in workspace → ask the AI a question only the file knows the answer to. The AI calls `search_knowledge`, gets back the relevant chunks via hybrid RRF retrieval (cosine + BM25), folds them into its reply. Live Mistral + Jina call via LiteLLM. Works on desktop and mobile (Phase 6.5+).
- **`delete-account-with-consequences`** (Workstream B) — profile page → click "Delete account" → consequences modal enumerates owned-doc deletion + comment anonymisation + workspace fates (sole-member cascade vs. promote-admin) → type-to-confirm email → grace banner appears → cancel button restores state. 8 variants (light/dark × desktop/mobile × single-member-workspace/multi-member-workspace). The flow asserts the consequence list MATCHES the planned fates, not just "the modal opened" — the consequences modal is the load-bearing UI for GDPR Art.17 informed consent and a stale text would be a real legal failure.
- **`data-export`** (Workstream B) — profile → "Your data" section → request export → wait for the worker to flip the row to `ready` → download link appears with 7-day-expiry copy → second request shows in history above the first. 8 variants. The flow does NOT crack the ZIP open (that'd duplicate `tests/integration/dataExport.test.ts`); it asserts the user-facing surface only.

Shipped since this list was drafted: the two-context fixture (`flow.spawn`, documented above — `password-protect` now uses a genuinely separate browser context), selective re-runs (`flows:test:changed` via `scripts/flows-test-changed.ts`), and CI integration (the PR gate in `ci.yml` runs no flow suite; the full suite incl. live-AI flows runs once per release in `release.yml`, for `release:*`-labeled merges only).

Future tier-1 work:

- **Doc-content i18n pattern** (currently captions are en-only).
- **`/docs/_internal/flows` gallery.**
- **Dedicated `MobileEditorPage`** so the desktop-only skips on `polished-pdf` / `import-existing` / `rich-content` / `pick-a-theme` can be replaced with mobile-shaped equivalents (Editor drawer + bottom-sheet variants).

## Mobile flow patterns

Phase 6.5–6.30 un-skipped 19 flows on mobile. The patterns below are the toolbox; use them when authoring or fixing a mobile spec.

### One spec per feature, branch by viewport

There is **one canonical spec per flow**, no `*-mobile.spec.ts` siblings. The 6 redundant mobile sibling specs (`polished-pdf-mobile`, `import-existing-mobile`, `knowledge-rag-mobile`, `pick-a-theme-mobile`, `document-context-mobile`, `rich-content-mobile`) were deleted. Branch on `editor.isMobile` inside the canonical spec. **`Flow.vue` auto-routes the rendered manifest variant by viewport** via `useMediaQuery('(max-width: 639px)')` + `useColorMode().value`, so docs pages don't need a separate `## On mobile` markdown section. Those sections were removed from `content/docs/**.md`; if the variant exists in `public/flows/<slug>/<locale>/<variant>/`, the embedded `<Flow>` will pick it up.

### Mobile entry points

- **Tab bar instead of right-sidebar tabs.** Desktop opens `editor.page.sidebar.{document, comments, activity, theme, knowledge}`; mobile opens `editor.page.mobileTabs.{...}`. Branch via `editor.isMobile`.
- **Hamburger menu instead of menubar.** Desktop's `nav[aria-label="Menu bar"] > button:has-text("File")` becomes `page.getByRole('button', { name: /^menu$/i }).first()` on mobile. The hamburger's `mobileMenuItems` in `EditorLayout.vue` mirrors the desktop File menu (New / Import / Export / Print / Save as PDF / Duplicate / Move / Delete) — the action is the same; only the entry point differs.

### Bottom-sheet portal interception

`mk-sheet-host` (the bottom-sheet container) intercepts pointer events on portaled popovers + modals rendered inside its stacking context. Reka USelect popovers + Reka Dialog modals refuse standard Playwright `click()` because the sheet's `aria-hidden="true"` overlay routes pointer events even when accessibility says it's hidden. **This is not a product bug** — real touch dispatches the same event chain; Playwright's coordinate-based clicks land at the wrong stacking layer. Three workarounds, in increasing aggressiveness:

1. **`click({ force: true })`** — works for many cases. Use first (`audience` / `language` USelect in `document-context`).
2. **DOM-level `el.click()` via `evaluate`** — bypasses coordinate routing entirely.
3. **Synthetic pointer-event sequence** for Reka primitives that listen on `pointerdown` / `pointerup`, not `click`:
   ```ts
   await el.evaluate((node) => {
     const opts = { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true }
     node.dispatchEvent(new PointerEvent('pointerdown', opts))
     node.dispatchEvent(new PointerEvent('pointerup', opts))
     node.click()
   })
   ```
   Right tool for cover-page-editor's layout USelect, activity-restore's restore-confirm modal, and similar Reka cases.

### Sheet vs. tab-bar interaction

The bottom sheet blocks the mobile tab bar — tapping a different tab while a sheet is open is intercepted. **Close the sheet first**: `await editor.page.locator('.mk-sheet-host button[aria-label="Close"]').click()` then `await editor.page.locator('.mk-sheet-host').waitFor({ state: 'detached' })`, OR press Escape (`BottomSheet.vue` listens on `document` keydown). Pattern used in `comment-context-expand`, `document-context`.

### Mobile is edit-only under `<sm`

`<PreviewPane v-if="viewMode !== 'edit'">` keeps the preview iframe **unmounted** on mobile when in edit mode. Specs that depend on iframe state (live preview, paged.js pagination, mermaid render) MUST guard those waits behind `if (!editor.isMobile)`:

```ts
if (!editor.isMobile) {
  await editor.waitForPreviewPaginated()
  await editor.page.locator('iframe').contentFrame()...evaluate(...)
}
```

`rich-content` and `polished-pdf` use this branch to skip the preview-iframe asserts on mobile while still asserting the document state via the editor (CM6) buffer.

### Selector hierarchy (and `getByText` is for ASSERTIONS)

Selector order of preference inside flow specs:

1. **`data-testid`** — first choice. Survives copy edits, locale changes, color-mode swaps.
2. **`getByRole('...', { name: /.../ })`** — when no testid exists.
3. **Structural CSS** — `[data-activity-id]`, `[data-comment-id]`, etc.
4. **`getByText(/.../)`** — content-assertion only.

**Never use `getByText(/.../)` as a wait gate.** The `activity-restore` mobile failure that taught the lesson: a wait for "the activity feed loaded" used `getByText(/edit/i).first()`, which on mobile matched the (hidden-but-rendered) menubar's `<button>Edit</button>` instead of an activity row. The wait passed instantly against the wrong element; the real activity row hadn't streamed in yet. Use the structural / testid hierarchy for waits.

### `waitForTimeout` vs API polling

Two different wait kinds, two different tools:

- **"Wait for ROW to appear in DB / state to flip"** → `expect.poll(() => fetch(...).count, { timeout, intervals })`. Right for activity-row appearance, AI-session ending, knowledge-file ready, export-job ready.
- **"Wait for HOCUSPOCUS BATCH WINDOW to close"** → fixed `waitForTimeout(3000)`. Hocuspocus debounces 2 s before flushing edits to `yjs_documents` (per `sync-server/src/index.ts:58`). When a flow needs N **distinct** activity rows, you have to wait out the batch window between typings — polling isn't enough, the row doesn't exist yet AND the next typing would land in the same already-open batch. 3 s = 2 s debounce + 1 s safety. The `activity-restore` flow tried polling here and exited at flush time, but the next typing landed in the same batch; only the fixed sleep separates them.

### Imperative AI prompts

When a flow asserts that the document body changed, phrase the prompt **imperatively**: "Insert a paragraph at the end of this document summarising X" — NOT "Summarise X" (reads as a chat question; Mistral may answer via `message_to_user` and land in the prompt-bar response panel instead of the doc). Pattern used in `knowledge-rag`. The prompt-engineering lever is "tool routing", not "model quality".

### AI flow-test timeouts

Live Mistral / Jina / BFL round-trips run **5–30 s** depending on tool count. `editor.waitForAiIdle()` defaults to 90 s (covers the worst case + safety). `rich-content` needs an extra 2 s buffer for mermaid render — polling `iframe div.mermaid img` doesn't beat the underlying CDN script-load + render delay.

## When you add a new flow

1. Add stable selectors to the relevant components (`data-testid` for non-text elements, `aria-label` for icon-only buttons).
2. Write the test. Title becomes the slug (`'Quick share'` → `quick-share`). Use `editor.recordPreamble()` if the flow IS about doc creation, `editor.silentSetup()` otherwise.
3. Add real assertions. The flow is a test; if there's no behaviour to assert beyond "the screenshots look right", reconsider the flow.
4. Author the docs page under `content/docs/<section>/<slug>.md` with frontmatter (`title`, `description`, `category`, `order`, optional `featured`). Embed the flow with `::flow{id="<slug>" mode="slides" hide-title}::`.
5. Run `bun run flows` (test + build) to verify.

## Gotchas

- **`docker compose down --remove-orphans` is a footgun in this project.** All compose files share the same project namespace (derived from the checkout directory name), so `--remove-orphans` treats services from OTHER compose files as orphans and removes them. `bun run flows:down` and `scripts/flows-ephemeral.ts` deliberately do NOT use `--remove-orphans`.
- **Caption inversion bug from SPA navigation.** A click that triggers `router.push()` keeps the OS cursor at the click coordinates AND keeps the same JS context, so `window.__flowCursor` still holds coordinates valid on page A's layout, not page B's. The injection script stamps `location.pathname` on every motion; `readCursor` returns null when the path has changed since.
- **Use `flow.click(caption, locator)` for navigation clicks**, NOT `flow.step('Click X', () => locator.click())`. The latter captures AFTER the click — the screenshot lands on the destination page with no meaningful cursor. `flow.click` hovers FIRST, screenshots WITH the cursor on the target, THEN clicks.
- **`<ContentRenderer>` wraps its output in an unstyled `<div>`.** The fix: pass `class="docs-content"` to `<ContentRenderer>` so the wrapper carries the grid styles directly.
- **SSR `$fetch('/flows/...')` doesn't route through Vite's static handler in dev.** Prefix all manifest URLs with `useRequestURL().origin` so the request becomes a real HTTP fetch (which DOES hit Vite).
- **Nuxt color mode resolution order is fragile.** Setting `colorScheme` on the Playwright project AND pre-seeding `nuxt-color-mode` localStorage via `addInitScript` together survive any change in @nuxtjs/color-mode's preference→value resolution. Belt + suspenders.
- **Nuxt devtools chrome shows up in screenshots if you don't strip it.** The badge is `#nuxt-devtools-container`. The fixture injects `display: none !important`.
- **`flow.click` opts must always pass a `Locator`, not a CSS selector string.**
- **Test title becomes the slug.** `'Quick share'` → `quick-share`. Renaming a test = changing the URL of every page that embeds it.
- **Stale test title = orphaned `public/flows/<old-slug>/`.** The build script does a clean rebuild so the old directory gets deleted next build.
- **1280×800 capture viewport (not Full HD).** Docs cap embedded flows at ~1100px wide. Capturing at 1920 made everything downscale to ~57%.
