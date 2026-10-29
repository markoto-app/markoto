import { test, expect } from '../fixtures/flow'
import path from 'node:path'

// Tier 1: "Bring an existing doc into markoto".
//
// User-job: a writer already has a Word/PDF/HTML article and wants
// to keep editing it as markdown. Job done when the file's text
// lands in the editor and the live preview shows it as a real doc.
//
// Markitdown handles the conversion (DOCX/PDF/PPTX/XLSX/HTML/EPUB → md).
// The flow uses an HTML fixture because:
//   1. HTML is one of the accepted formats — real users do import
//      web articles and exports.
//   2. The conversion is deterministic (no markitdown LLM step on
//      HTML), so the captured screenshots are stable across runs.
//   3. .docx fixtures need binary tooling to generate; HTML is
//      check-in-friendly as plain text.
//
// Runs on desktop AND mobile. Same import dialog + markitdown
// conversion pipeline; entry point differs:
//   - Desktop: File → Import…
//   - Mobile: hamburger ("more") → Import…
// (`mobileMenuItems` in EditorLayout.vue surfaces Import alongside
// New / Export / Print at the top of the file group.)
test('Import existing document', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Login + disable cover so the imported content is the FIRST
  // thing on page 1 of the preview iframe (anon users get 401 from
  // the PUT /meta endpoint that toggles cover.enabled).
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup({ title: 'Quarterly report' })
  await editor.page.disableCoverPage()

  // ─── Open the import dialog ──────────────────────────────────────
  await flow.heading('Bring your existing document in', 3)
  await flow.narrate(
    'Already have a draft in Word, a PDF, an HTML export from a CMS? '
    + 'markoto converts it to markdown on the way in. The conversion '
    + 'preserves headings, lists, tables, and inline emphasis — what '
    + 'you can’t carry over (custom fonts, page chrome) is dropped, '
    + 'since you’re going to re-style with a markoto theme anyway.'
  )

  // Open the menu containing Import.
  // Desktop: top-level File menu (hidden on mobile via `hidden sm:block`).
  // Mobile: hamburger ("more") in the topbar.
  const openMenuTrigger = editor.isMobile
    ? page.getByRole('button', { name: /^menu$/i }).first()
    : page.locator('nav[aria-label="Menu bar"] > button').first()

  await flow.click(
    editor.isMobile ? 'Open the topbar menu' : 'Click the File menu',
    openMenuTrigger,
    editor.isMobile
      ? {
          result: 'The topbar menu opens — Import sits in the file actions.',
          after: () => page.getByRole('menuitem', { name: /^import/i }).first().waitFor({ state: 'visible' })
        }
      : {
          annotations: [
            { label: 'file menu', selector: 'nav[aria-label="Menu bar"] > button:first-child', kind: 'arrow' }
          ],
          result: 'The File menu opens — Import sits above Export.',
          after: () => page.getByRole('menuitem', { name: /^import/i }).first().waitFor({ state: 'visible' })
        }
  )

  // Click Import — opens the modal.
  await flow.click(
    'Click "Import…" to open the picker',
    page.getByRole('menuitem', { name: /^import/i }).first(),
    {
      annotations: [
        { label: 'import', selector: '[role="menuitem"]:has-text("Import")', kind: 'arrow' }
      ],
      result: 'The import dialog opens — drop a file, or click to pick one.',
      after: () => page.locator('[data-testid="import-dropzone"]').waitFor({ state: 'visible' })
    }
  )

  // ─── Pick the file ───────────────────────────────────────────────
  await flow.heading('Pick the file you want to import', 3)
  await flow.narrate(
    'The dialog accepts Word (.docx), PDF, PowerPoint, Excel, HTML, '
    + 'and EPUB up to 50 MB. markoto converts it to Markdown with '
    + 'Microsoft’s open-source markitdown library, on its own servers.'
  )

  // The dropzone uses VueUse's `useFileDialog` which opens a native
  // file picker — Playwright captures it via the filechooser event.
  // CRITICAL: register the waitForEvent BEFORE the click that opens
  // the dialog. The chooser fires synchronously inside the click;
  // an `after` hook on flow.click registers the listener too late.
  const fixture = path.resolve('tests/e2e/fixtures/import-files/q3-launch-postmortem.html')
  const dropzone = page.locator('[data-testid="import-dropzone"]')
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 })

  await flow.click(
    'Click the dropzone to open the file picker',
    dropzone,
    {
      annotations: [
        { label: 'dropzone', selector: 'div:has-text("Click to select a file"):not(:has(div))', kind: 'box' }
      ],
      result: 'Your file is selected — its name + size show up so you can confirm.',
      after: async () => {
        // The click above already opened the chooser; the pre-
        // registered promise resolved with it. Set the file, then
        // wait for the dropzone to flip to its "selected" state.
        const chooser = await chooserPromise
        await chooser.setFiles(fixture)
        await page.getByText(/q3-launch-postmortem\.html/i).waitFor({ state: 'visible', timeout: 5_000 })
      }
    }
  )

  // ASSERTION: the selected-file pane is now visible with the right name.
  await expect(page.getByText(/q3-launch-postmortem\.html/i)).toBeVisible()

  // ─── Trigger the import ──────────────────────────────────────────
  await flow.heading('Convert and load it into the editor', 3)
  await flow.narrate(
    'Hit Import. The file is converted to Markdown and lands '
    + 'directly in the editor — your headings, '
    + 'lists, and emphasis arrive intact, ready for further editing.'
  )

  // Click the Import action button — it sits in the modal footer
  // next to Cancel. Scope to the dialog so we don't accidentally
  // re-match the now-closed File menu's "Import…" item.
  const importBtn = page.locator('[data-testid="import-submit"]')
  await flow.click(
    'Click "Import" to convert and load',
    importBtn,
    {
      // Conflict path: silentSetup leaves the seeded welcome doc
      // (~30 lines), so applyImport asks how to merge instead of
      // replacing automatically. The Replace button is in the
      // conflict pane that takes over the modal.
      result: 'markoto asks how to merge — your existing content vs the imported markdown.',
      after: () => page.locator('[data-testid="import-replace-all"]').waitFor({ state: 'visible', timeout: 60_000 })
    }
  )

  // Click Replace to drop the welcome content and use the imported file.
  await flow.click(
    'Click "Replace" — drop the welcome content, use the import',
    page.locator('[data-testid="import-replace-all"]'),
    {
      // Hero outcome: the imported text appearing in the editor IS
      // the payoff. Readers who hit this flow are evaluating "can
      // I move my work over?" — seeing real headings + lists in
      // the editor + preview answers it.
      hero: true,
      result: 'Your headings, lists, and prose land in the editor — preview '
        + 'shows the polished version live.',
      after: async () => {
        await expect(page.locator('.cm-content')).toContainText(/Q3 launch postmortem/i, { timeout: 30_000 })
        // Re-paginate the preview so the outcome shot lands on a
        // populated page, not a transitional blank one. Mobile is
        // edit-only (`v-if="viewMode !== 'edit'"` keeps the preview
        // iframe unmounted under `<sm`), so there's no iframe to
        // wait on — `cm-content` text is the only useful signal.
        if (!editor.isMobile) {
          await editor.page.waitForPreviewPaginated()
        }
      }
    }
  )

  // ASSERTION: real imported content is in the doc + preview iframe.
  // We don't assert exact HTML→md fidelity (markitdown's output
  // shape is its contract, not ours); we assert that recognizable
  // landmarks survived the round-trip.
  const editorText = await page.locator('.cm-content').textContent()
  expect(editorText).toMatch(/Q3 launch postmortem/i)
  expect(editorText).toMatch(/What worked/i)
  expect(editorText).toMatch(/What we'll change/i)

  // Forward route: now that the doc is in markoto, the next step
  // is making it look right — pick a theme.
  flow.next({
    slug: 'pick-a-theme',
    why: 'Now make it look the part — pick a theme that fits your audience'
  })
})
