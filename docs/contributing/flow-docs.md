# Flow docs

The user documentation at `/docs` is built from Playwright tests. Each "flow" is a test that asserts real product behaviour and, while it runs, records a slideshow: screenshots with captions, a fake browser frame with an address bar, the cursor position and highlight callouts. The same run that proves a feature works produces its tutorial.

Agent rules for writing flows live in [`tests/e2e/AGENTS.md`](../../tests/e2e/AGENTS.md).

## Pipeline

```
tests/e2e/flows/<slug>.spec.ts        Playwright test using the `flow` + `editor` fixtures
        │  bun run flows:test
        ▼
tests/e2e/output/flows/<slug>/<locale>/<variant>/
  ├─ manifest.json                    entries (chapters, narration, approach/outcome shots)
  ├─ NN.webp                          screenshots, deduplicated by content hash
  └─ .passed                          sentinel written when the test passed
        │  bun run flows:build  (scripts/build-flows.ts)
        ▼
public/flows/<slug>/<locale>/<variant>/   committed, served statically
        │
        ▼
content/docs/<section>/<page>.md      ::flow{id="<slug>" mode="slides"}::
        │  rendered by app/pages/docs/[...slug].vue → app/components/content/Flow.vue
        ▼
/docs site
```

The slug is the slugified test title (`'Quick share'` → `quick-share`). Renaming a test renames its output directory and breaks every page that embeds it.

## Writing a flow

```ts
test('Quick share', async ({ flow, editor }) => {
  await editor.recordPreamble()
  await flow.heading('Name your document', 3)
  await flow.narrate('Documents start untitled.')
  await flow.click('Click the title to rename it', editor.page.titleButton, { result: 'The title becomes editable.' })
  await flow.step('Type a name and press Enter', () => editor.page.commitTitleEdit('My doc'))
  await flow.shot('The title is set', { hero: true })
  flow.next({ slug: 'discuss-with-comments', why: 'Invite a teammate to comment inline.' })
})
```

### The `flow` recorder (`tests/e2e/fixtures/flow.ts`)

| Call | What it records |
|---|---|
| `flow.step(caption, action, opts?)` | Runs `action`, then takes a screenshot. Use when the action's target is also what the shot shows (typing into a field). |
| `flow.click(caption, locator, opts)` | Hovers the locator, takes a screenshot with the cursor on the target, then clicks. Use for every click that navigates. |
| `flow.hover(caption, locator, opts?)` | Like `click` without the click. |
| `flow.type(caption, locator, text, opts)` | Types into a field and records it. |
| `flow.shot(caption, opts?)` | Screenshot without an action. |
| `flow.narrate(text)` | Prose between shots. |
| `flow.heading(text, level?)` | Section break (level 2 or 3). |
| `flow.skipNext()` | Suppresses the next automatic screenshot (for transient states). |
| `flow.next({ slug, why })` | The "Try next" card after the last slide. `why` is one short sentence in the user's voice. The last call wins. |
| `flow.spawn(label)` | Opens a second, independent browser context (own cookies and storage) and returns `{ flow, page, editor }` for it. Its frames go into the same manifest, stamped with `actor: <label>`. Used by `password-protect`: the owner sets a password, a separate visitor opens the link. Spawned contexts close at teardown. |
| `flow.expectErrorToast(pattern)` / `flow.expectServerError(pattern)` | Declares an error toast or a 5xx response the flow provokes on purpose. |

Shot options:

- `highlights: [{ label, selector }]` draws pulsing callouts on an outcome ("look at what appeared"). Selectors resolve to a bounding box at capture time. With `FLOW_STRICT=1` or `CI=true` an unresolved selector fails the test; locally it only warns.
- `annotations: [{ label, selector, kind? }]` points at a non-obvious click target on the approach frame. Kinds: `arrow` (default, for small or peripheral targets), `box` (a dashed outline around a bounded region), `pin` (numbered disc, for several targets in one shot).
- `hero: true` marks the decisive outcome; it is shown above the slideshow. The first hero wins, across all spawned actors.
- `addressBar: 'Downloads/<file>'` replaces the frame's address bar text (a value without a leading `/` replaces domain and path). Pair it with the download viewers in `tests/e2e/fixtures/downloadViewer.ts`: `showPdf` renders a downloaded PDF's pages with pdf.js, `showTextFile` shows an exported `.md`.

### The `editor` fixture

- `editor.recordPreamble()` records opening the home page and creating a document. Use it when document creation is part of the story.
- `editor.silentSetup(opts?)` creates the document without recording. `opts.title` names it, `opts.body` replaces the welcome text, `opts.cover: false` turns the cover page off so the preview's first page shows content.
- `editor.page` is the `EditorPage` page object (`tests/e2e/page-objects/`) with stable selectors and helpers such as `setDocText`, `docText`, `scrollEditorTo`, `scrollPreviewTo`, `dismissToasts`, `switchToSplitView`, `waitForPreviewPaginated`.
- `editor.isMobile` tells the spec which viewport it runs in.

### Automatic failure signals

Every flow fails on any error toast and on any 5xx response from the app origin, checked before each capture and at teardown, for all actors, unless the flow declared it with `expectErrorToast` / `expectServerError`.

### Captions

Flows are end-user documentation:

- Write in the user's voice. No internal names (Hocuspocus, Y.js, "the editor mounts").
- Leave out steps that do not move the user toward the goal.
- End at a tangible outcome: a copied link, a PDF, a locked document.
- Every step has an assertion behind it.

## Capture details

- An init script tracks the pointer position together with `location.pathname`. A cursor recorded on another path is dropped, so a shot taken after a client-side navigation has no stale cursor.
- Each shot records `new URL(page.url()).pathname` for the address bar in `<FlowFrame>`.
- Screenshots are converted to lossless WebP and SHA-256 hashed; a frame identical to an earlier one reuses its file.
- The fixture pre-seeds the `nuxt-color-mode` localStorage key in addition to the project's `colorScheme`, and hides `#nuxt-devtools-container`.

## Playwright projects (`playwright.config.ts`)

One project per locale and variant: `en-light-desktop`, `en-dark-desktop`, `en-light-mobile`, `en-dark-mobile`. Desktop is 1280×800 (the docs site shows flows at about 1100 px wide); mobile is 390×720 with touch, below the app's 640 px breakpoint. `metadata.variant` names the output directory. Clipboard and microphone permissions are granted for all projects.

`Flow.vue` picks the variant from the reader's color mode and viewport (`max-width: 639px` selects a mobile variant), so a docs page embeds one `::flow` and readers on phones see the mobile frames.

## Running flows

| Command | What it does |
|---|---|
| `bun run flows:test` | `scripts/flows-ephemeral.ts`: starts the test stack, runs `bun run build`, serves the production build on port 3001 as `http://markoto.localhost:3001` (sync on `ws://markoto.localhost:4002`), runs Playwright, tears everything down. `FLOWS_SKIP_BUILD=1` reuses `.output/`. |
| `bun run flows:test:changed` | `scripts/flows-test-changed.ts`: runs only the flows affected by your changes. |
| `bun run flows:build` | Rebuilds `public/flows/` from `tests/e2e/output/flows/`. |
| `bun run flows` | `flows:test` then `flows:build`. |
| `bun run flows:up` / `flows:down` | Starts or stops the test stack without running anything. |
| `bun run flows:test:against-running` | Runs Playwright against an app at `PLAYWRIGHT_BASE_URL` (default `http://localhost:3000`). |

`flows:test` runs Playwright in three passes against the same stack, restarting only the app server; a pass with no matching flow is skipped:

| Pass | Selects | App shape |
|---|---|---|
| default | untagged flows | billing off, paid plans "coming soon", marketing site off |
| billing | `@billing` | billing on (`FLOWS_BILLING_ENABLED=1` for Playwright) |
| marketing | `@marketing` | default shape plus `NUXT_MARKETING_SITE_ENABLED=true` (`FLOWS_MARKETING_ENABLED=1`) |

Tag a test with `test('…', { tag: '@marketing' }, …)` when it needs the hosted marketing pages, which return 404 otherwise. `playwright.config.ts` excludes both tags unless the matching variable is set.

`FLOWS_SERVE_ONLY=1 bun run flows:test` keeps one server running for `flows:test:against-running`; `FLOWS_BILLING=on` or `FLOWS_MARKETING=on` serve the other shapes.

The flows use the same compose file as the integration tests (`docker-compose.test.yml`, see [testing.md](testing.md)). Teardown runs `down -v` without `--remove-orphans`.

## Publishing

`scripts/build-flows.ts` publishes only slugs that a page under `content/docs/` embeds with `::flow{id="…"}`, so test-only flows (for example the `@billing` checkout flows) never ship. A variant is republished only if its `.passed` sentinel exists; a failed variant keeps its previously published frames. Slugs without a source directory or an embedding page are removed.

"Try next" cards resolve `next.slug` to the docs page that embeds it (`shared/docs/flowDocPages.ts`, scanned at build time into `appConfig.flowDocPages`). `tests/unit/seo/flowDocPages.test.ts` fails when a spec's `flow.next` names a flow no page embeds.

### From a release

CI does not run flows on pull requests. `release.yml` (job `run-flows-and-collect-outputs`, `release:*`-labelled merges only) runs `bun run flows:test` with live AI and uploads `tests/e2e/output/flows` as the `flow-output` artifact, including the `.passed` sentinels. `.github/workflows/publish-flow-shots.yml` then rebuilds `public/flows/` from that artifact and opens a `docs: publish the vX.Y.Z flow screenshots` pull request labelled `release:none`.

The screenshots are part of the app image, so they reach a deployment with the next release. Never label the screenshots pull request `release:*`: its release would capture new screenshots and open another such pull request.

By hand: dispatch `publish-flow-shots.yml` with a run id, or `gh run download <run-id> -n flow-output -D tests/e2e/output/flows` (move a local `tests/e2e/output/` aside first), `bun run flows:build`, and commit `public/flows/`.

## Adding a flow

1. Add stable selectors to the components involved (`data-testid`, `aria-label` on icon-only buttons).
2. Write `tests/e2e/flows/<slug>.spec.ts`. One spec per flow; branch on `editor.isMobile` for mobile.
3. Assert the behaviour, not only the screenshots.
4. Write the docs page `content/docs/<section>/<slug>.md` with frontmatter (`title`, `description`, `category`, `order`, optional `featured`) and embed `::flow{id="<slug>" mode="slides" hide-title}::`.
5. Run `bun run flows:test:changed` (or `bun run flows`) and look at the frames in `tests/e2e/output/flows/<slug>/`.

## Product-tour captures

The product page's scene videos are recorded from the real app by `tests/e2e/tour/*.capture.ts` with `playwright.tour.config.ts` (projects `tour-light` / `tour-dark`), using the fixture in `tests/e2e/tour/fixture.ts`. Frames are captured step by step, not screen-recorded, and written to `$TOUR_OUTPUT_DIR/<mode>/<scene>/`. The demo content is `tests/e2e/tour/content/demoDocument.ts`. `bun run tour:capture` (`scripts/capture-tour.ts`) records and encodes (ffmpeg with libsvtav1 and libx264) and writes `public/tour/manifest.json`, whose schema `shared/tour/manifest.ts` is checked by `tests/unit/seo/tourManifest.test.ts`. The AI scenes need `MISTRAL_API_KEY` and `JINA_AI_API_KEY`.
