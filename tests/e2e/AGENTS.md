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

- **`voice-dictate`** (slug: `speak-instead-of-typing`) — toolbar mic → live dictation streams text into the editor as it's spoken. Pipeline: `MediaRecorder` + audio worklet → WebSocket `/api/ai/dictate` → Cloud STT `streamingRecognize` → CM6 ghost-text widget → Y.js commit with `dictation:{userId}` origin. Test uses the canned-fake STT mock (`NUXT_GOOGLE_SPEECH_MOCK=1`) plus Chromium's `--use-fake-device-for-media-stream` so the synthetic 16 kHz tone produces the chunk count the mock counts to fire its predetermined "how are you" final transcript. Works on desktop and mobile.
- **`document-context`** (slug: `tell-the-ai-who-you-re-writing-for`) — open the Document tab → set Description + Audience=Marketing + Language=Deutsch → ask the AI for an intro. The AI returns marketing-tone Deutsch without the prompt mentioning audience or language. Live Gemini call. Desktop only — the form scrolls below the fold on mobile.
- **`knowledge-rag`** (slug: `knowledge-grounded-ai`) — workspace setup → upload Q3 postmortem HTML → wait for ready → create new doc in workspace → ask the AI a question only the file knows the answer to. The AI calls `search_knowledge`, gets back the relevant chunks via hybrid RRF retrieval (cosine + BM25), folds them into its reply. Live Gemini call. Desktop only (workspace landing page packs the layout awkwardly on `<sm`).

Future tier-1 work:

- **Two-context fixture for password-protect.** Currently the flow simulates a fresh visitor by clearing cookies + reloading in the same context (honest because the narrative says "to simulate a visitor in this single browser, we drop the doc-scoped cookie and reload"). A real second `browser.newContext()` would let the screenshots come from a genuinely different browser identity AND from a visitor whose JWT expires independently of the owner's session.
- **Selective re-runs**: `flows:test:changed` for incremental dev.
- **CI integration.**
- **Doc-content i18n pattern** (currently captions are en-only).
- **`/docs/_internal/flows` gallery.**
- **Dedicated `MobileEditorPage`** so the desktop-only skips on `polished-pdf` / `import-existing` / `rich-content` / `pick-a-theme` can be replaced with mobile-shaped equivalents (Editor drawer + bottom-sheet variants).

## When you add a new flow

1. Add stable selectors to the relevant components (`data-testid` for non-text elements, `aria-label` for icon-only buttons).
2. Write the test. Title becomes the slug (`'Quick share'` → `quick-share`). Use `editor.recordPreamble()` if the flow IS about doc creation, `editor.silentSetup()` otherwise.
3. Add real assertions. The flow is a test; if there's no behaviour to assert beyond "the screenshots look right", reconsider the flow.
4. Author the docs page under `content/docs/<section>/<slug>.md` with frontmatter (`title`, `description`, `category`, `order`, optional `featured`). Embed the flow with `::flow{id="<slug>" mode="slides" hide-title}::`.
5. Run `bun run flows` (test + build) to verify.

## Gotchas

- **`docker compose down --remove-orphans` is a footgun in this project.** All compose files share the same project namespace (`md-online`), so `--remove-orphans` treats services from OTHER compose files as orphans and removes them. `bun run flows:down` and `scripts/flows-ephemeral.ts` deliberately do NOT use `--remove-orphans`.
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
