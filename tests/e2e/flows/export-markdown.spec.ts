import { test, expect } from '../fixtures/flow'

// Tier 1: "Save the doc as a .md file."
//
// User-job: a writer wants the markdown source on their disk — to
// commit to a git repo, paste into another tool, archive, or share
// the source verbatim with a collaborator who doesn't use markoto.
// Job done when File → Save as Markdown triggers a `.md` download
// containing the doc body.
//
// Lighter sibling of polished-pdf. The PDF goes through the
// renderer sidecar; the markdown is a one-line client-side
// `URL.createObjectURL(new Blob(...))` of the editor's source.
// No server round-trip, no S3, no auth — works on anonymous docs
// too.
//
// Runs on desktop AND mobile. Same client-side download path; entry
// point differs:
//   - Desktop: File → Export → "Markdown (.md)" submenu pick.
//   - Mobile: hamburger ("more") → "Export" (the mobile menu flattens
//     Export's submenu down to its markdown action — Print + Save as
//     PDF live as separate items in the same hamburger).
test('Save as Markdown', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.silentSetup()

  await flow.heading('Save the doc as a .md file', 3)
  await flow.narrate(
    'Sometimes you want the source, not the rendered output. File → '
    + 'Save as Markdown writes a `.md` of your doc straight to your '
    + 'downloads folder — no PDF render, no server round-trip, just '
    + 'the raw markdown. Useful for committing to a git repo, '
    + 'pasting into another tool, or archiving the source.'
  )

  // ─── Open the menu containing Export ────────────────────────────
  const openMenuTrigger = editor.isMobile
    ? page.getByRole('button', { name: /^menu$/i }).first()
    : page.locator('nav[aria-label="Menu bar"] > button').first()

  await flow.click(
    editor.isMobile ? 'Open the topbar menu' : 'Click the File menu',
    openMenuTrigger,
    {
      result: editor.isMobile
        ? 'The topbar menu opens — Export sits in the file actions.'
        : 'The File menu opens — Export sits between Import and Print.',
      after: () => page.getByRole('menuitem', { name: /^export$/i }).first().waitFor({ state: 'visible' })
    }
  )

  // Desktop opens a format submenu (Markdown / PDF); mobile collapses
  // Export to mean "markdown" directly, so the click below triggers
  // the download.
  let triggerLocator: import('@playwright/test').Locator
  let triggerCaption: string
  if (editor.isMobile) {
    triggerLocator = page.getByRole('menuitem', { name: /^export$/i }).first()
    triggerCaption = 'Tap "Export" to download the .md'
  } else {
    await flow.hover(
      'Hover "Export" for the format submenu',
      page.getByRole('menuitem', { name: /^export$/i }).first()
    )
    triggerLocator = page.getByRole('menuitem', { name: /markdown \(\.md\)/i }).first()
    await triggerLocator.waitFor({ state: 'visible' })
    triggerCaption = 'Click "Markdown (.md)" to download'
  }

  // ─── Trigger the download ───────────────────────────────────────
  // The export-markdown handler creates an object URL and triggers
  // an `<a download="...">` click. Playwright's download event
  // captures it. Pre-register BEFORE the click that triggers it.
  const downloadPromise = page.waitForEvent('download', { timeout: 10_000 })

  await flow.click(
    triggerCaption,
    triggerLocator,
    {
      hero: true,
      result: 'The .md file downloads to your disk — same content as what '
        + 'you see in the editor, ready to commit or share.'
    }
  )

  // ASSERTION: a download fired and the suggested filename ends
  // with .md. Don't open the file — we just want to confirm the
  // export path triggered.
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.md$/i)

  flow.next({
    slug: 'polished-pdf',
    why: 'Or download a styled PDF instead — same File menu, different format'
  })
})
