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
// Desktop only — File menu lives in the menubar (hidden `<sm`).
// Mobile users get the same action via the Editor drawer's
// File section, covered by the mobile sibling flows.
test('Save as Markdown', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'File menu is desktop-only; the mobile equivalent surface is in the Editor drawer (covered by polished-pdf-mobile and friends).'
  )
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

  // ─── File menu → Save as Markdown ───────────────────────────────
  await flow.click(
    'Click the File menu',
    page.locator('nav[aria-label="Menu bar"] > button').first(),
    {
      result: 'The File menu opens — Export sits between Import and Print.',
      after: () => page.getByRole('menuitem', { name: /export/i }).first().waitFor({ state: 'visible' })
    }
  )

  // Hover Export to reveal the format submenu (Markdown + PDF).
  await flow.hover(
    'Hover "Export" for the format submenu',
    page.getByRole('menuitem', { name: /^export$/i }).first()
  )

  const mdItem = page.getByRole('menuitem', { name: /markdown \(\.md\)/i }).first()
  await mdItem.waitFor({ state: 'visible' })

  // ─── Trigger the download ───────────────────────────────────────
  // The export-markdown handler creates an object URL and triggers
  // an `<a download="...">` click. Playwright's download event
  // captures it. Pre-register BEFORE the click that triggers it.
  const downloadPromise = page.waitForEvent('download', { timeout: 10_000 })

  await flow.click(
    'Click "Markdown (.md)" to download',
    mdItem,
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
