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
- **`opts.highlights: [{ label, selector }, ...]`** — pulsating orange callouts on a shot. Selector is resolved to a bounding box AT screenshot time. Strict mode (`FLOW_STRICT=1` or `CI=true`) fails when a selector resolves to nothing; local dev keeps a soft warning.
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
  "version": 1,
  "title": "Quick share",
  "slug": "quick-share",
  "locale": "en",
  "variant": "light",
  "viewport": { "w": 1280, "h": 800 },
  "entries": [
    { "kind": "heading", "level": 2, "text": "Name your document" },
    { "kind": "narrate", "text": "Documents start untitled..." },
    {
      "kind": "shot",
      "file": "01.png",
      "caption": "Click the placeholder title to rename it",
      "cursor": { "x": 129, "y": 24 },
      "path": "/d/abc",
      "highlights": [{ "label": "Word count", "x": 16, "y": 760, "w": 80, "h": 18 }]
    }
  ]
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
