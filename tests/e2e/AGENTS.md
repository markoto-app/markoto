# Flow tests (Playwright): agent rules

Each spec in `tests/e2e/flows/` is both a test and a page of the user docs at `/docs`. How the pipeline, fixture API, passes and publishing work: [`docs/contributing/flow-docs.md`](../../docs/contributing/flow-docs.md). Test tiers and the test stack: [`docs/contributing/testing.md`](../../docs/contributing/testing.md).

## Writing a flow

- Captions are end-user docs: user voice, no internal names (Hocuspocus, Y.js, "the editor mounts"), end at a tangible outcome, and every step has an assertion behind it.
- The test title is the slug (`'Quick share'` → `quick-share`). Renaming a test breaks every docs page that embeds it; update `content/docs/` in the same change.
- Use `flow.click(caption, locator, opts)` for any click that navigates, never `flow.step('Click X', () => locator.click())`, `step` captures after the click and lands on the next page with a stale cursor.
- Pass a Playwright `Locator` to `flow.click` / `flow.hover` / `flow.type`, never a CSS selector string.
- `flow.next({ slug })` must name a flow some `content/docs/` page embeds, or `tests/unit/seo/flowDocPages.test.ts` fails.
- A flow that provokes an error toast or a 5xx on purpose must declare it (`flow.expectErrorToast` / `flow.expectServerError`); otherwise the fixture fails the flow.
- Tag flows that need billing on `@billing`, flows that need the hosted marketing pages `@marketing`. Untagged flows run against the free-only hosted shape.
- Don't duplicate lower tiers: a flow asserts what the user sees (e.g. `data-export` does not open the ZIP; `tests/repos/dataExport.test.ts` covers its content).

## Mobile

- One spec per flow. No `*-mobile.spec.ts` siblings; branch on `editor.isMobile`. `Flow.vue` picks the mobile variant by viewport, so docs pages need no separate mobile section.
- Mobile uses the tab bar (`editor.page.mobileTabs.*`) instead of the right sidebar (`editor.page.sidebar.*`), and the `Menu` button instead of the desktop menu bar.
- Mobile is edit-only: the preview iframe is not mounted in edit mode. Guard every preview wait (`waitForPreviewPaginated`, iframe locators, Mermaid) with `if (!editor.isMobile)`, and assert the document through the editor text instead. To show a rendered result on mobile, switch with a recorded tap on `editor.page.mobilePreviewButton`.
- The bottom sheet blocks the tab bar. Close it first: click `.mk-sheet-host button[aria-label="Close"]`, then wait for `.mk-sheet-host` to be detached.

### Bottom-sheet portal interception

`mk-sheet-host` intercepts pointer events on popovers and modals portaled inside it, so a normal Playwright `click()` on a Reka select option or dialog button inside a bottom sheet lands on the wrong layer. This is a Playwright coordinate-routing issue, not a product bug. Workarounds, least aggressive first:

1. **`click({ force: true })`**, try this first (e.g. the audience / language selects in `document-context`).
2. **DOM-level `el.click()` via `evaluate`**, bypasses coordinate routing entirely.
3. **Synthetic pointer events** for Reka primitives that listen on `pointerdown` / `pointerup`:
   ```ts
   await el.evaluate((node) => {
     const opts = { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true }
     node.dispatchEvent(new PointerEvent('pointerdown', opts))
     node.dispatchEvent(new PointerEvent('pointerup', opts))
     node.click()
   })
   ```

## Selectors and waits

- Selector preference: `data-testid` → `getByRole(…, { name })` → structural attributes (`[data-activity-id]`, `[data-comment-id]`) → `getByText`.
- Never use `getByText` as a wait gate. It can match hidden-but-rendered elements (on mobile, `/edit/i` matches the hidden menu bar's "Edit" button) and pass instantly. Use it for content assertions only.
- Waiting for a row or state change: `expect.poll(...)` against the API.
- Waiting for distinct activity rows from successive edits: `waitForTimeout(3000)` between the edits. The sync server debounces stores by 2 s (`debounce: 2000`, `maxDebounce: 10000` in `sync-server/src/index.ts`); polling cannot help because the next edit would land in the same store batch.
- AI round-trips take 5–30 s; use `editor.waitForAiIdle()` (default timeout 240 s), don't hand-roll shorter timeouts.
- Phrase AI prompts that must change the document imperatively ("Insert a paragraph at the end … summarising X"). A question ("Summarise X") may be answered in the prompt-bar panel instead of the document.

## Running and publishing

- Never run `docker compose … down --remove-orphans` on the test stack: all compose files share one project namespace and the flag removes the dev stack's containers.
- Don't hand-edit `public/flows/`; it is rebuilt by `bun run flows:build` or the `publish-flow-shots.yml` pull request.
- Never label the flow-screenshots pull request `release:*`: its release would capture new screenshots and open the next such pull request, endlessly.
