import { test, expect } from '../fixtures/flow'

// Tier 1: "Polish your document and download it as a PDF".
//
// User-job: a writer has finished their draft and wants to send a
// publishable artefact. Job done when they pick a theme, see the
// cover-page preview, and trigger a server-rendered PDF.
//
// What this flow ISN'T: a full theme-knob tour (that's pick-a-theme).
// We do ONE preset switch to show "themes are real" then commit to
// the export path — the surface most users don't know exists.
//
// Desktop-only: the menubar (File → Save as PDF) is hidden on mobile
// (`hidden sm:block`), and the mobile editor commands drawer doesn't
// surface PDF export. Mobile users who want a PDF currently use the
// browser's print menu, which a flow can't capture cleanly.
//
// Captioning rules under the v2 (approach + outcome) model:
//   • Imperative captions on flow.click(...) → "Click X", "Pick Y"
//   • Declarative `result` on the outcome → "X happens", "Y appears"
//   • Annotations on approach frames anchor click targets
//   • One hero on the most decisive outcome
test('Polished PDF', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'Polished PDF is desktop-only — the File menu (containing Save as PDF) is hidden on `<sm`. Mobile users currently use the browser print dialog, which the flow harness cannot capture.'
  )
  test.setTimeout(120_000)

  await editor.silentSetup()

  // Title + intro.
  await flow.heading('Download a polished PDF', 3)
  await flow.narrate(
    'When the doc looks right in the live preview, the PDF on disk '
    + 'will look exactly the same — paged.js renders both. The File → '
    + 'Save as PDF item triggers a server-side render in the renderer '
    + 'sidecar; the byte-perfect PDF travels via S3 instead of through '
    + 'the user\'s browser print dialog. Theme picking + tweaking is '
    + 'a separate flow (see the next link below); this one focuses on '
    + 'the export path.'
  )

  // ─── Save it as a PDF ───────────────────────────────────────────
  await flow.heading('Save it as a polished PDF', 3)
  await flow.narrate(
    'When the doc looks right in the live preview, the PDF on disk '
    + 'will look exactly the same — same paged.js engine renders both. '
    + 'The File → Save as PDF item triggers a server-side render in '
    + 'the renderer sidecar, so the byte-perfect PDF travels via S3 '
    + 'instead of through the user\'s print dialog.'
  )

  // Open the File menu. The menubar is below the topbar — readers
  // who skipped the menubar tour need an arrow to find "File" among
  // seven sibling triggers (File / Edit / View / Insert / Format /
  // Sharing / Help). The triggers are plain `<button>`s rendered by
  // UDropdownMenu, NOT role=menuitem (those are the items INSIDE the
  // dropdown when it opens).
  const fileMenuTrigger = page.locator('nav[aria-label="Menu bar"] > button').first()
  await flow.click(
    'Click the File menu',
    fileMenuTrigger,
    {
      annotations: [
        { label: 'file menu', selector: 'nav[aria-label="Menu bar"] > button:first-child', kind: 'arrow' }
      ],
      result: 'The File menu opens — New, Import, Export, Print, Duplicate, Delete.',
      after: () => page.getByRole('menuitem', { name: /export/i }).first().waitFor({ state: 'visible' })
    }
  )

  // Hover the Export submenu to expose Markdown / PDF.
  await flow.hover(
    'Hover "Export" to reveal the format submenu',
    page.getByRole('menuitem', { name: /^export$/i }).first(),
    {
      annotations: [
        { label: 'export submenu', selector: '[role="menuitem"]:has-text("Export")', kind: 'arrow' }
      ]
    }
  )

  // Wait for the PDF item to be visible inside the submenu.
  const pdfItem = page.getByRole('menuitem', { name: /pdf \(\.pdf\)/i }).first()
  await pdfItem.waitFor({ state: 'visible' })

  // Click "PDF (.pdf)" — opens a new tab via target="_blank" pointing
  // at /api/docs/{id}/pdf?inline=1. The PDF endpoint runs the renderer
  // sidecar (cache-miss = ~5-15s, hit = sub-second), then 302s to a
  // presigned S3 URL with Content-Disposition forcing attachment.
  // Hero outcome: a real PDF download triggered by one click.
  const popupPromise = page.context().waitForEvent('page', { timeout: 30_000 })
  await flow.click(
    'Click "PDF (.pdf)" to render and download',
    pdfItem,
    {
      hero: true,
      result: 'A new tab opens — markoto renders the PDF on the server and '
        + 'streams it back as a download. Same view, same fonts, same cover.'
    }
  )

  // ASSERTION: a popup actually opened with the PDF endpoint URL.
  // Doesn't assert on the rendered PDF bytes (those vary with renderer
  // version + theme tweaks); the contract we care about is "click hits
  // the documented endpoint".
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded').catch(() => { /* PDF nav often skips DCL */ })
  expect(popup.url()).toMatch(/\/api\/docs\/[^/]+\/pdf/)

  // Forward route: now that the PDF path is visible, locking the doc
  // down (so only specific people can view it) is the natural next
  // permission step. Routes to password-protect.
  flow.next({
    slug: 'password-protect',
    why: 'Now lock the doc down — share it only with people you trust'
  })
})
