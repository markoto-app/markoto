import { readFile } from 'node:fs/promises'
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
// Runs on desktop AND mobile. Same server-rendered PDF endpoint
// (`/api/docs/:id/pdf`); entry point differs:
//   - Desktop: File → Export → "PDF (.pdf)" submenu pick.
//   - Mobile: hamburger ("more") → "PDF (.pdf)" (the mobile menu
//     surfaces the server-PDF item at top level — Print is a separate
//     item for the browser dialog).
//
// Captioning rules under the v2 (approach + outcome) model:
//   • Imperative captions on flow.click(...) → "Click X", "Pick Y"
//   • Declarative `result` on the outcome → "X happens", "Y appears"
//   • Annotations on approach frames anchor click targets
//   • One hero on the most decisive outcome
test('Polished PDF', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.silentSetup({ title: 'Research summary' })

  // Title + intro.
  await flow.heading('Download a polished PDF', 3)
  await flow.narrate(
    'When the doc looks right in the live preview, the PDF on disk '
    + 'will look exactly the same — both come out of the same page '
    + 'layout. File → Save as PDF renders the file on the server and '
    + 'downloads it, no browser print dialog involved. Theme picking + tweaking is '
    + 'a separate flow (see the next link below); this one focuses on '
    + 'the export path.'
  )

  // ─── Save it as a PDF ───────────────────────────────────────────
  await flow.heading('Save it as a polished PDF', 3)
  await flow.narrate(
    'When the doc looks right in the live preview, the PDF on disk '
    + 'will look exactly the same — both come out of the same page '
    + 'layout. File → Save as PDF renders the file on the server and '
    + 'downloads it, no print dialog involved.'
  )

  // Open the menu containing PDF export.
  // Desktop has a top-level menubar (hidden on mobile via `hidden sm:block`).
  // Mobile collapses File / Edit / View / etc. into a single hamburger
  // ("more") UDropdownMenu. The "PDF (.pdf)" item is nested under
  // Export on desktop but lifted to top level on mobile so the
  // pick-server-PDF action stays one tap away.
  const openMenuTrigger = editor.isMobile
    ? page.getByRole('button', { name: /^menu$/i }).first()
    : page.locator('nav[aria-label="Menu bar"] > button').first()

  await flow.click(
    editor.isMobile ? 'Open the topbar menu' : 'Click the File menu',
    openMenuTrigger,
    editor.isMobile
      ? {
          result: 'The topbar menu opens — "PDF (.pdf)" is one of the file actions.',
          after: () => page.getByRole('menuitem', { name: /pdf \(\.pdf\)/i }).first().waitFor({ state: 'visible' })
        }
      : {
          annotations: [
            { label: 'file menu', selector: 'nav[aria-label="Menu bar"] > button:first-child', kind: 'arrow' }
          ],
          result: 'The File menu opens — New, Import, Export, Print, Duplicate, Delete.',
          after: () => page.getByRole('menuitem', { name: /export/i }).first().waitFor({ state: 'visible' })
        }
  )

  // Desktop: hover Export to reveal the format submenu, then wait for
  // PDF (.pdf). Mobile: PDF is already a top-level item, no submenu.
  if (!editor.isMobile) {
    await flow.hover(
      'Hover "Export" to reveal the format submenu',
      page.getByRole('menuitem', { name: /^export$/i }).first(),
      {
        annotations: [
          { label: 'export submenu', selector: '[role="menuitem"]:has-text("Export")', kind: 'arrow' }
        ]
      }
    )
  }

  // Wait for the PDF item to be visible (submenu on desktop; top-level
  // on mobile — same locator either way).
  const pdfItem = page.getByRole('menuitem', { name: /pdf \(\.pdf\)/i }).first()
  await pdfItem.waitFor({ state: 'visible' })

  // Click "PDF (.pdf)" — opens a new tab via target="_blank" pointing
  // at /api/docs/{id}/pdf?inline=1. The PDF endpoint runs the renderer
  // sidecar (cache-miss = ~5-15s, hit = sub-second), then 302s to a
  // presigned S3 URL with Content-Disposition forcing attachment.
  // Hero outcome: a real PDF download triggered by one click.
  const popupPromise = page.context().waitForEvent('page', { timeout: 30_000 })
  // Registered BEFORE the click so a fast download can't slip past.
  // NOTE: the download fires on the OPENER page (this one), not on the
  // popup — Chromium attributes it to the initiating frame even with
  // rel="noopener" (verified empirically; the popup itself never
  // commits a navigation in headless and reports url() === ':').
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null)
  await flow.click(
    'Click "PDF (.pdf)" to render and download',
    pdfItem,
    {
      hero: true,
      result: 'A new tab opens — markoto renders the PDF on the server and '
        + 'streams it back as a download. Same view, same fonts, same cover.'
    }
  )

  // ASSERTION: the click produced a real server-rendered PDF. Two
  // browser behaviours cover the same product outcome:
  //   • HEADLESS Chromium (CI + every flows run) has no PDF viewer —
  //     the popup's navigation becomes a DOWNLOAD (attributed to the
  //     opener page) and the popup never commits. The old
  //     waitForLoadState + popup.url() assert hung here until the
  //     120s test timeout; the opener's `download` event is the
  //     signal that actually fires.
  //   • HEADED Chrome renders the PDF inline — no download event; the
  //     popup commits to the endpoint URL (302 → presigned S3
  //     /renders/.../document.pdf). That's the fallback branch.
  // The server chain itself (render → S3 → 302) is proven fast; see
  // the renderer log line `docId=… format=pdf pages=… ms=…`.
  const popup = await popupPromise
  const download = await downloadPromise
  if (download) {
    // Download URL is the final hop (presigned S3 /renders/… key) or
    // the endpoint itself, depending on how the browser reports it.
    expect(download.url()).toMatch(/\/api\/docs\/[^/]+\/pdf|\/renders\/.+\.pdf/)
    // The hero claim is "a real PDF lands on disk" — check the magic
    // bytes, not just the URL shape.
    const filePath = await download.path()
    const head = await readFile(filePath)
    expect(head.subarray(0, 5).toString()).toBe('%PDF-')
  } else {
    // Headed fallback: PDF viewer rendered it inline in the popup.
    await popup.waitForURL(/\/api\/docs\/[^/]+\/pdf|\/renders\/.+\.pdf/, { timeout: 15_000 })
    expect(popup.url()).toMatch(/\/api\/docs\/[^/]+\/pdf|\/renders\/.+\.pdf/)
  }

  // Forward route: now that the PDF path is visible, locking the doc
  // down (so only specific people can view it) is the natural next
  // permission step. Routes to password-protect.
  flow.next({
    slug: 'password-protect',
    why: 'Now lock the doc down — share it only with people you trust'
  })
})
