import { test, expect } from '../fixtures/flow'

// Tier 1 (mobile sibling): "Download a polished PDF — on mobile."
//
// User-job: same as polished-pdf.spec.ts, but every interaction
// happens through the mobile bottom tab bar + editor drawer instead
// of the desktop menubar. Mobile users get the SAME PDF — same
// renderer sidecar, same paged.js engine, same S3 streamed download.
//
// Mobile-only: skips on desktop variants. The desktop story is told
// by polished-pdf.spec.ts; this one shows that mobile users hit the
// File items via the Editor tab → drawer.
test('Download a polished PDF on mobile', async ({ page, flow, editor }) => {
  test.skip(
    !editor.isMobile,
    'Mobile-only sibling — desktop story is in polished-pdf.spec.ts.'
  )
  test.setTimeout(120_000)

  await editor.silentSetup()

  await flow.heading('Download a polished PDF on mobile', 3)
  await flow.narrate(
    'Mobile users get the same PDF as desktop — same paged.js render, '
    + 'same S3 streamed download. The File menu is hidden on `<sm` (no '
    + 'menubar at narrow widths), so Save as PDF lives in the Editor '
    + 'drawer instead. Tap the Editor tab on the bottom bar; the drawer '
    + 'slides up; tap Save as PDF; markoto opens the rendered PDF in a '
    + 'new tab.'
  )

  // ─── Open the Editor drawer ─────────────────────────────────────
  await flow.click(
    'Tap the Editor tab on the bottom bar',
    editor.page.mobileTabs.editor,
    {
      result: 'The Editor drawer slides up — formatting, headings, lists, '
        + 'inserts, and the File items at the bottom.',
      after: () => editor.page.mobileEditorCommands.exportPdf.waitFor({ state: 'visible', timeout: 10_000 })
    }
  )

  // ─── Trigger the PDF render ─────────────────────────────────────
  await flow.heading('Save as PDF', 3)
  await flow.narrate(
    'The File section sits at the bottom of the drawer — Import, Save '
    + 'as PDF, Save as Markdown. Tap Save as PDF and the renderer '
    + 'sidecar materialises a byte-perfect render of your doc, then '
    + 'opens it in a new tab as a download. First render takes 5-15s '
    + '(cold paged.js); subsequent renders for the same doc snapshot '
    + 'are sub-second cache hits.'
  )

  // The Save as PDF button opens a new tab via target="_blank" (same
  // openServerPdf handler the desktop menubar uses). Pre-register
  // the popup wait BEFORE the click; the popup fires synchronously.
  const popupPromise = page.context().waitForEvent('page', { timeout: 30_000 })
  await flow.click(
    'Tap "PDF (.pdf)" to render and download',
    editor.page.mobileEditorCommands.exportPdf,
    {
      hero: true,
      result: 'A new tab opens — markoto renders the PDF on the server and '
        + 'streams it back as a download. Same view, same fonts, same cover.'
    }
  )

  // ASSERTION: a popup opened to the PDF endpoint URL.
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded').catch(() => { /* PDF nav often skips DCL */ })
  expect(popup.url()).toMatch(/\/api\/docs\/[^/]+\/pdf/)

  flow.next({
    slug: 'password-protect',
    why: 'Now lock the doc down — gate the PDF link behind a password'
  })
})
