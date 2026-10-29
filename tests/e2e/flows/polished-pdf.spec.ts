import { readFile } from 'node:fs/promises'
import { test, expect } from '../fixtures/flow'
import { showPdf } from '../fixtures/pdfViewer'

// Tier 1: "Polish your document and download it as a PDF".
//
// User-job: a writer has finished their draft and wants to send a
// publishable artefact. Job done when the PDF is on disk and opens
// looking like the preview (cover page included).
//
// What this flow ISN'T: a theme tour (that's pick-a-theme). It goes
// straight to the export path — the surface most users don't know exists.
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
const RESEARCH_SUMMARY = [
  '# Remote work and focus time',
  '',
  'We surveyed 412 people across six teams about how they protect time for deep work. Three habits stood out, and two of them cost nothing to adopt.',
  '',
  '## Key findings',
  '',
  '1. **Shared quiet hours** beat individual calendar blocks: teams that agreed on two meeting-free mornings a week reported 31% more uninterrupted work.',
  '2. **Written updates** replaced most status meetings without anyone missing them.',
  '3. **Notification batching** helped, but only when the whole team did it.',
  '',
  '## Recommendation',
  '',
  'Start with shared quiet hours. They need one team decision, no new tools, and the effect shows up within two weeks.'
].join('\n')

test('Polished PDF', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.silentSetup({ title: 'Research summary', body: RESEARCH_SUMMARY })

  await flow.heading('Download a polished PDF', 3)
  await flow.narrate(
    'When the document looks right in the preview on the right, the PDF '
    + 'looks the same: same theme, same cover page, same page breaks. '
    + 'markoto builds the file for you and downloads it. No print dialog, '
    + 'no fiddling with margins.'
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
          result: 'The File menu opens: New, Import, Export, Print and Delete.',
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
    'Click "PDF (.pdf)" to create and download the file',
    pdfItem,
    {
      result: 'markoto renders the PDF and your browser downloads it. A new render '
        + 'takes a few seconds; asking again without changes is instant.',
      after: async () => {
        await downloadPromise
      }
    }
  )

  // ASSERTION: the click produced a real server-rendered PDF. Two
  // browser behaviours cover the same product outcome:
  //   • HEADLESS Chromium (CI + every flows run) has no PDF viewer —
  //     the popup's navigation becomes a DOWNLOAD (attributed to the
  //     opener page) and the popup never commits.
  //   • HEADED Chrome renders the PDF inline — no download event; the
  //     popup commits to the endpoint URL (302 → presigned S3
  //     /renders/.../document.pdf). That's the fallback branch.
  const popup = await popupPromise
  const download = await downloadPromise
  const pdfUrl = `${new URL(page.url()).origin}/api/docs/${editor.page.currentDocId()}/pdf?inline=1`
  let pdf: Buffer
  if (download) {
    expect(download.url()).toMatch(/\/api\/docs\/[^/]+\/pdf|\/renders\/.+\.pdf/)
    pdf = await readFile(await download.path())
  } else {
    // Headed fallback: the viewer rendered it inline in the popup.
    await popup.waitForURL(/\/api\/docs\/[^/]+\/pdf|\/renders\/.+\.pdf/, { timeout: 15_000 })
    pdf = Buffer.from(await (await page.request.get(pdfUrl)).body())
  }
  // The hero claim is "a real PDF lands on disk" — check the magic bytes.
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')

  // ─── Open the file ──────────────────────────────────────────────
  // Show the downloaded bytes the way a reader opens them. Headless
  // Chromium has no PDF viewer, so `showPdf` stands in for it (pdf.js,
  // real file contents) at the URL the menu item opened.
  await flow.heading('Open the PDF', 3)
  const viewer = await flow.spawn('pdf')
  const pageCount = await showPdf(viewer.page, pdfUrl, pdf, editor.isMobile ? 1 : 2)
  // ASSERTION: cover + content — at least two pages.
  expect(pageCount).toBeGreaterThanOrEqual(2)
  await viewer.flow.shot(
    editor.isMobile
      ? 'The downloaded PDF opens with the same cover page as the preview.'
      : 'The downloaded PDF: the cover page and the first page of content, exactly as in the preview.',
    { hero: true }
  )

  // Forward route: now that the PDF path is visible, locking the doc
  // down (so only specific people can view it) is the natural next
  // permission step. Routes to password-protect.
  flow.next({
    slug: 'password-protect',
    why: 'Now lock the doc down — share it only with people you trust'
  })
})
