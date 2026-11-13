import { test, expect } from '../fixtures/flow'
import type { EditorPage } from '../page-objects/Editor'

// "Zoom the preview and see all pages".
//
// User-job: a writer working on a long report wants to read a page up
// close, then step back and see the whole document at once, where the
// tables land, which page a chapter starts on, and jump straight to a
// page from there. Job done when they've zoomed in, pulled back into
// the all-pages overview, opened a page from it, and found the preview
// the way they left it after a reload.
//
// Runs on desktop (zoom pill in the preview pane, Ctrl/Cmd + =) and on
// mobile (the zoom button in the floating view-mode switch).

const SECTIONS = [
  ['Summary', 'This was the year the company turned profitable. Revenue grew by a third, the share of recurring revenue passed ninety percent for the first time, and the team doubled without slowing down the release schedule.'],
  ['Customers', 'We closed the year with 2,140 paying workspaces. Most of the growth came from teams of ten to fifty people who moved their planning documents, launch notes and customer reports into shared drafts.'],
  ['Product', 'We shipped templates, workspace themes and the new export pipeline. Exports are now twice as fast, and a document looks the same on screen, on paper and in the PDF a customer receives.'],
  ['People', 'The team grew from 18 to 31 people across three countries. Every new colleague wrote their onboarding notes in the product, which turned out to be the best usability test we ran all year.'],
  ['Finance', 'Gross margin improved by four points, mostly because hosting costs grew more slowly than revenue. We ended the year with nineteen months of runway and no new debt.'],
  ['Risks', 'Our largest risk is concentration: the ten biggest customers account for a fifth of revenue. We are spreading it by investing in self-serve plans for smaller teams.'],
  ['Outlook', 'Next year we focus on three things: faster collaboration on long documents, better templates for recurring reports, and help from the AI that cites its sources.']
]

const REPORT = SECTIONS.flatMap(([title, text], i) => [
  `## ${title}`,
  '',
  text,
  '',
  `${text} The numbers below compare the last three quarters.`,
  '',
  '| Quarter | Revenue (EUR k) | Customers | Change |',
  '|---|---:|---:|---:|',
  `| Q2 | ${4100 + i * 120} | ${1650 + i * 40} | +${4 + i}% |`,
  `| Q3 | ${4480 + i * 120} | ${1820 + i * 40} | +${5 + i}% |`,
  `| Q4 | ${4920 + i * 120} | ${2140 + i * 40} | +${6 + i}% |`,
  '',
  `${text} ${text}`,
  '',
  `${text}`,
  '',
  '<!-- pagebreak -->',
  ''
]).join('\n')

/** What the preview shows: the zoom mode class, factor and how many pages share the first row. */
function previewZoomState(editor: EditorPage) {
  return editor.previewRoot().evaluate((html) => {
    const pages = Array.from(document.querySelectorAll<HTMLElement>('#mount .pagedjs_page'))
    const firstTop = pages[0]?.getBoundingClientRect().top ?? 0
    const container = document.querySelector<HTMLElement>('#mount .pagedjs_pages')
    return {
      overview: html.classList.contains('zoom-overview'),
      zoom: Number(container?.style.getPropertyValue('--page-zoom') ?? '0'),
      pages: pages.length,
      firstRow: pages.filter(p => Math.abs(p.getBoundingClientRect().top - firstTop) < 2).length,
      animating: html.classList.contains('zoom-animating')
    }
  })
}

/** Index (1-based) of the page whose top is nearest the top of the preview. */
function pageAtTop(editor: EditorPage) {
  return editor.previewRoot().evaluate(() => {
    const pages = Array.from(document.querySelectorAll<HTMLElement>('#mount .pagedjs_page'))
    let best = 0
    let bestDistance = Infinity
    pages.forEach((p, i) => {
      const d = Math.abs(p.getBoundingClientRect().top)
      if (d < bestDistance) {
        bestDistance = d
        best = i
      }
    })
    return best + 1
  })
}

test('Zoom the preview', async ({ page, flow, editor }) => {
  test.setTimeout(150_000)
  await editor.silentSetup({ title: 'Annual report', body: REPORT, cover: false })
  if (editor.isMobile) await editor.page.showMobilePreview()
  await editor.page.waitForPreviewPaginated(30_000)
  await expect.poll(async () => (await previewZoomState(editor.page)).pages).toBeGreaterThanOrEqual(7)

  const settled = () => expect.poll(async () => (await previewZoomState(editor.page)).animating).toBe(false)

  await flow.heading('Zoom the preview and see all pages', 3)
  await flow.narrate(
    'The preview shows your document as real pages. By default one page '
    + 'fills the width of the preview. You can zoom in to read the small '
    + 'print, or step back and see every page at once.'
  )

  if (editor.isMobile) {
    // Mobile: the zoom button next to Edit / Preview
    const zoomButton = page.getByTestId('preview-zoom-mobile')
    await flow.click('Tap the zoom button next to Edit and Preview', zoomButton, {
      annotations: [{ label: 'zoom', selector: '[data-testid="preview-zoom-mobile"]', kind: 'arrow' }],
      result: 'Pick fit width, all pages, or a fixed zoom.',
      after: () => page.getByRole('menuitemcheckbox', { name: 'All pages' }).waitFor({ state: 'visible' })
    })
    await flow.click('Tap "All pages"', page.getByRole('menuitemcheckbox', { name: 'All pages' }), {
      result: 'The preview pulls back: every page side by side, two or three to a row.',
      hero: true,
      after: async () => {
        await expect.poll(async () => (await previewZoomState(editor.page)).overview).toBe(true)
        await settled()
        expect((await previewZoomState(editor.page)).firstRow).toBeGreaterThanOrEqual(2)
      }
    })
    const thumb = editor.page.page.frameLocator('iframe').first().locator('#mount .pagedjs_page').nth(3)
    await flow.click('Tap a page to open it', thumb, {
      result: 'Page 4 opens at full width, right where you tapped.',
      after: async () => {
        await expect.poll(async () => (await previewZoomState(editor.page)).overview).toBe(false)
        await settled()
        expect(await pageAtTop(editor.page)).toBe(4)
      }
    })
    await flow.narrate('You can also pinch the preview with two fingers to zoom in and out. Pinch all the way out to see all pages.')
    // Back to all pages, the setting the next chapter reloads with.
    await zoomButton.click()
    await page.getByRole('menuitemcheckbox', { name: 'All pages' }).click()
    await expect.poll(async () => (await previewZoomState(editor.page)).overview).toBe(true)
    await settled()
  } else {
    // Desktop: the zoom control in the preview's corner
    const control = page.getByTestId('preview-zoom-control')
    await expect(control).toBeVisible()
    const fitZoom = (await previewZoomState(editor.page)).zoom
    expect(fitZoom).toBeGreaterThan(0)
    expect(fitZoom).toBeLessThanOrEqual(1)

    await flow.click('Click + in the preview\'s top right corner to zoom in', page.getByTestId('preview-zoom-in'), {
      annotations: [{ label: 'zoom', selector: '[data-testid="preview-zoom-control"]', kind: 'box' }],
      result: 'The page grows to the next zoom step. The text you were reading stays in view.',
      after: async () => {
        await settled()
        // The next fixed step above what fit width showed.
        const next = [0.5, 0.75, 1, 1.25, 1.5, 2].find(step => step > fitZoom * 1.05) ?? 2
        expect((await previewZoomState(editor.page)).zoom).toBeCloseTo(next, 5)
        await expect(page.getByTestId('preview-zoom-menu')).toHaveText(`${Math.round(next * 100)}%`)
      }
    })

    await flow.click('Open the zoom menu for a fixed size', page.getByTestId('preview-zoom-menu'), {
      result: 'Fit width, all pages, or a fixed size from 50% to 200%.',
      after: () => page.getByRole('menuitemcheckbox', { name: '150%' }).waitFor({ state: 'visible' })
    })
    await flow.click('Choose 150%', page.getByRole('menuitemcheckbox', { name: '150%' }), {
      result: 'Large enough to check footnotes and table figures. Scroll sideways for the rest of the line.',
      after: async () => {
        await settled()
        expect((await previewZoomState(editor.page)).zoom).toBeCloseTo(1.5, 5)
        await expect(page.getByTestId('preview-zoom-menu')).toHaveText('150%')
      }
    })

    await flow.heading('See all pages', 3)
    await flow.click('Click the grid button to see all pages', page.getByTestId('preview-zoom-overview'), {
      annotations: [{ label: 'all pages', selector: '[data-testid="preview-zoom-overview"]', kind: 'arrow' }],
      result: 'The preview pulls back into an overview: all pages side by side, as many to a row as fit.',
      hero: true,
      after: async () => {
        await expect.poll(async () => (await previewZoomState(editor.page)).overview).toBe(true)
        await settled()
        const state = await previewZoomState(editor.page)
        expect(state.firstRow).toBeGreaterThanOrEqual(4)
        expect(state.zoom).toBeLessThan(fitZoom)
        await expect(page.getByTestId('preview-zoom-overview')).toHaveAttribute('aria-pressed', 'true')
      }
    })

    const thumb = editor.page.page.frameLocator('iframe').first().locator('#mount .pagedjs_page').nth(4)
    await flow.click('Click a page to open it', thumb, {
      result: 'The preview zooms back in on page 5, at full width.',
      after: async () => {
        await expect.poll(async () => (await previewZoomState(editor.page)).overview).toBe(false)
        await settled()
        expect(await pageAtTop(editor.page)).toBe(5)
        expect((await previewZoomState(editor.page)).zoom).toBeCloseTo(fitZoom, 5)
      }
    })

    await flow.heading('Zoom from the keyboard', 3)
    await flow.narrate(
      'With the pointer over the preview, Ctrl and + zooms in, Ctrl and − '
      + 'zooms out and Ctrl and 0 goes back to fit width (Cmd on a Mac). '
      + 'Hold Ctrl and scroll, or pinch on a trackpad, for any size in '
      + 'between. The browser\'s own zoom stays as it is.'
    )
    const accel = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.locator('iframe[title="Document preview"]').hover()
    // One step below fit width, then on down past 50% into the overview.
    const below = [0.5, 0.75, 1, 1.25, 1.5, 2].filter(step => step < fitZoom / 1.05)
    await page.keyboard.press(`${accel}+Minus`)
    await expect.poll(async () => (await previewZoomState(editor.page)).zoom).toBeCloseTo(below.at(-1) ?? 0, 5)
    for (let i = 1; i < below.length; i++) await page.keyboard.press(`${accel}+Minus`)
    await expect.poll(async () => (await previewZoomState(editor.page)).overview).toBe(false)
    await page.keyboard.press(`${accel}+Minus`)
    await expect.poll(async () => (await previewZoomState(editor.page)).overview).toBe(true)
    await settled()
    await flow.shot('Zoomed out past 50%, the preview shows all pages again.')
  }

  // Remembered for next time
  await flow.heading('Your zoom is remembered', 3)
  await page.reload()
  await editor.page.waitForReady(30_000)
  if (editor.isMobile) await editor.page.showMobilePreview()
  await editor.page.waitForPreviewPaginated(30_000)
  await expect.poll(async () => (await previewZoomState(editor.page)).overview).toBe(true)
  await flow.shot(
    'After a reload the preview opens on all pages again. The choice is kept in this browser, for every document.'
  )

  flow.next({
    slug: 'polished-pdf',
    why: 'Turn the document you just looked over into a PDF'
  })
})
