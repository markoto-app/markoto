import { test, expect } from '../fixtures/flow'
import path from 'node:path'

// Tier 1 (mobile sibling): "Bring an existing doc in — on mobile."
//
// User-job: same as import-existing.spec.ts but driven through the
// Editor drawer (no menubar on `<sm`). Mobile users get the same
// markitdown round-trip; the drawer's File section surfaces Import
// alongside Save as PDF / Save as Markdown.
//
// Mobile-only: skips on desktop variants.
test('Import existing document on mobile', async ({ page, flow, editor }) => {
  test.skip(
    !editor.isMobile,
    'Mobile-only sibling — desktop story is in import-existing.spec.ts.'
  )
  test.setTimeout(120_000)

  // Login + disable cover (see desktop sibling for reasoning).
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup()
  await editor.page.disableCoverPage()

  await flow.heading('Bring your existing document in on mobile', 3)
  await flow.narrate(
    'Already have a draft in Word, a PDF, or an HTML export? markoto '
    + 'converts it to markdown on the way in. The desktop File menu is '
    + 'hidden at narrow widths — tap the Editor tab on the bottom bar '
    + 'and the same Import action lives in the drawer\'s File section.'
  )

  // ─── Open the Editor drawer ─────────────────────────────────────
  await flow.click(
    'Tap the Editor tab on the bottom bar',
    editor.page.mobileTabs.editor,
    {
      result: 'The Editor drawer slides up — File items at the bottom.',
      after: () => editor.page.mobileEditorCommands.import.waitFor({ state: 'visible', timeout: 10_000 })
    }
  )

  // ─── Pick a file ────────────────────────────────────────────────
  await flow.heading('Pick the file you want to import', 3)
  await flow.narrate(
    'Tap Import; the import dialog opens with a tappable dropzone. '
    + 'The accepted formats are the same as desktop: Word, PDF, '
    + 'PowerPoint, Excel, HTML, EPUB up to 50 MB.'
  )

  await flow.click(
    'Tap Import to open the dialog',
    editor.page.mobileEditorCommands.import,
    {
      result: 'The import dialog opens — drop a file, or tap the dropzone.',
      after: () => page.locator('[data-testid="import-dropzone"]').waitFor({ state: 'visible' })
    }
  )

  // Same chooser dance as the desktop spec — register BEFORE the
  // click that opens it.
  const fixture = path.resolve('tests/e2e/fixtures/import-files/q3-launch-postmortem.html')
  const dropzone = page.locator('[data-testid="import-dropzone"]')
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 })

  await flow.click(
    'Tap the dropzone to open the file picker',
    dropzone,
    {
      result: 'Your file is selected — its name + size show up so you can confirm.',
      after: async () => {
        const chooser = await chooserPromise
        await chooser.setFiles(fixture)
        await page.getByText(/q3-launch-postmortem\.html/i).waitFor({ state: 'visible', timeout: 5_000 })
      }
    }
  )

  await expect(page.getByText(/q3-launch-postmortem\.html/i)).toBeVisible()

  // ─── Import + replace ───────────────────────────────────────────
  await flow.heading('Convert and load it into the editor', 3)
  await flow.narrate(
    'Tap Import to send the file through markitdown. Because the doc '
    + 'already has the welcome content, markoto asks how to merge — '
    + 'tap Replace all to drop the welcome and use the imported file.'
  )

  const importBtn = page.locator('[data-testid="import-submit"]')
  await flow.click(
    'Tap Import to convert + load',
    importBtn,
    {
      result: 'markoto asks how to merge — your existing content vs the imported markdown.',
      after: () => page.locator('[data-testid="import-replace-all"]').waitFor({ state: 'visible', timeout: 60_000 })
    }
  )

  await flow.click(
    'Tap "Replace all" — drop the welcome content',
    page.locator('[data-testid="import-replace-all"]'),
    {
      hero: true,
      result: 'Your headings, lists, and prose land in the editor — same as desktop.',
      after: async () => {
        await expect(page.locator('.cm-content')).toContainText(/Q3 launch postmortem/i, { timeout: 30_000 })
      }
    }
  )

  // ASSERTION: real imported content lives in the markdown source.
  const editorText = await page.locator('.cm-content').textContent()
  expect(editorText).toMatch(/Q3 launch postmortem/i)
  expect(editorText).toMatch(/What worked/i)

  flow.next({
    slug: 'pick-a-theme',
    why: 'Now make it look the part — pick a theme that fits your audience'
  })
})
