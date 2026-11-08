import fs from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { showPdf } from '../fixtures/downloadViewer'
import type { EditorFixture } from '../fixtures/flow'
import {
  test,
  expect,
  settlePreview,
  applyTheme,
  useOwnMistralKey,
  withCover,
  withTheme,
  TOUR_OUTPUT,
  type Rect
} from './fixture'
import { demoDocument as demo } from './content/demoDocument'

// Scenes 1, 2, 3 and 8 of the product tour, each a short looping video
// recorded step by step on the Quaybridge report (cover off unless the
// cover is the point).

/** Centre the preview on the first element matching `selector` (optionally containing `text`). */
async function previewTo(page: Page, selector: string, text?: string): Promise<void> {
  const frame = page.frameLocator('iframe').first()
  const target = text ? frame.locator(`#mount ${selector}`, { hasText: text }).first() : frame.locator(`#mount ${selector}`).first()
  await expect(target).toBeAttached({ timeout: 20_000 })
  await target.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(400)
}

/** Area of the preview iframe (for phone cuts). */
async function previewRect(page: Page): Promise<Rect> {
  const box = await page.locator('iframe').first().boundingBox()
  return box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(Math.min(box.height, 900 - box.y)) } : { x: 720, y: 120, w: 720, h: 760 }
}

async function openReport(page: Page, editor: EditorFixture, body: string, theme: unknown): Promise<void> {
  await editor.page.loginAsTestUser(demo.author)
  await useOwnMistralKey(page)
  await editor.silentSetup({ title: demo.title, body })
  await applyTheme(page, theme)
  await settlePreview(page, 1500)
}

const noCover = withCover(demo.theme, false)

/**
 * The write scene's section: the "Executive summary" heading, its first
 * paragraph and the key-figures table — typed into the finished report
 * (which, for this scene, lacks the rest of the summary and highlights).
 */
function writeSection(markdown: string): { before: string, section: string[], after: string } {
  const at = markdown.indexOf('# Executive summary')
  const rest = markdown.indexOf('\n# ', at + 1)
  if (at < 0 || rest < 0) throw new Error('report has no Executive summary section')
  const blocks = markdown.slice(at, rest).trim().split(/\n{2,}/)
  const heading = blocks[0] ?? ''
  const paragraph = blocks[1] ?? ''
  const figuresAt = blocks.findIndex(b => b.startsWith('## Key figures'))
  const table = blocks[figuresAt + 1] ?? ''
  if (!heading.startsWith('# ') || figuresAt < 0 || !table.startsWith('|')) throw new Error('unexpected Executive summary shape')
  return { before: markdown.slice(0, at), section: [heading, paragraph, '## Key figures', table], after: markdown.slice(rest + 1) }
}

/** Typing steps for the section: a few characters, then words, then table rows per frame. */
function sectionSteps(section: string[]): string[] {
  const steps: string[] = []
  let done = ''
  const join = (more: string) => (done ? `${done}\n\n${more}` : more)
  for (const block of section) {
    if (block.startsWith('|')) {
      const rows = block.split('\n')
      for (let r = 1; r <= rows.length; r++) {
        // The separator row has no cells of its own: type it with the header.
        if (r === 1) continue
        steps.push(join(rows.slice(0, r).join('\n')))
      }
    } else if (block.startsWith('#')) {
      for (let n = 4; n < block.length + 4; n += 4) steps.push(join(block.slice(0, Math.min(n, block.length))))
    } else {
      const words = block.split(' ')
      for (let n = 3; n < words.length + 3; n += 3) steps.push(join(words.slice(0, Math.min(n, words.length)).join(' ')))
    }
    done = join(block)
  }
  return steps
}

/** Keep the preview on the page being written, the newest block in view. */
async function followSection(page: Page): Promise<void> {
  await page.frameLocator('iframe').first().locator('#mount').evaluate((mount: HTMLElement) => {
    // The page being written (before the heading exists: the page after
    // the table of contents, where it will appear).
    const h1 = [...mount.querySelectorAll('h1')].find(h => /Executive summary/.test(h.textContent ?? '')) ?? mount.querySelector('h1')
    const sheet = h1?.closest('.pagedjs_page')
    sheet?.scrollIntoView({ block: 'start' })
    const figures = [...mount.querySelectorAll('h2')].find(h => /Key figures/.test(h.textContent ?? ''))
    const table = figures?.closest('.pagedjs_page')?.querySelector('table')
    table?.scrollIntoView({ block: 'nearest' })
  })
}

/**
 * The pull-back: the preview's own pages (paged.js output, untouched, at
 * the preview's own fit `--page-zoom`) laid out in rows, and a camera
 * transform on the mount that starts on the page that was just written
 * and scales down until the whole report fits the pane (`renderSpread`,
 * 0 … 1). Scaling the laid-out pages down (never laying them out tiny and
 * scaling up) keeps the text exactly as the preview set it.
 */
async function prepareSpread(page: Page): Promise<void> {
  await page.frameLocator('iframe').first().locator('#mount').evaluate((mount: HTMLElement) => {
    const pages = mount.querySelector<HTMLElement>('.pagedjs_pages')
    const sheets = [...mount.querySelectorAll<HTMLElement>('.pagedjs_page')]
    const h1 = [...mount.querySelectorAll('h1')].find(h => /Executive summary/.test(h.textContent ?? ''))
    const focus = h1?.closest<HTMLElement>('.pagedjs_page')
    if (!pages || !focus || sheets.length === 0) throw new Error('preview not paginated')
    const r0 = focus.getBoundingClientRect()
    const W = window.innerWidth
    // The prompt bar floats over the pane's bottom: keep the spread above it.
    const H = window.innerHeight - 76
    // Page size and gap as laid out now (the fit zoom applied).
    const first = sheets[0]?.getBoundingClientRect()
    const pw = first?.width ?? 600
    const ph = first?.height ?? 850
    const gap = 16 * (pw / (sheets[0]?.offsetWidth || pw))
    // The column count that shows every page as large as possible.
    let best = { k: 0, cols: 1 }
    for (let cols = 2; cols <= 8; cols++) {
      const rows = Math.ceil(sheets.length / cols)
      const k = Math.min((W * 0.9) / (cols * pw + (cols - 1) * gap), (H * 0.9) / (rows * ph + (rows - 1) * gap))
      if (k > best.k) best = { k, cols }
    }
    window.scrollTo(0, 0)
    document.documentElement.style.overflow = 'hidden'
    pages.style.flexDirection = 'row'
    pages.style.flexWrap = 'wrap'
    pages.style.justifyContent = 'center'
    pages.style.alignContent = 'flex-start'
    // The container's own width is in unzoomed px (CSS zoom scales it).
    const zoom = pw / (sheets[0]?.offsetWidth || pw)
    pages.style.width = `${(best.cols * pw + (best.cols - 1) * gap) / zoom}px`
    pages.style.maxWidth = 'none'
    mount.style.width = 'max-content'
    mount.style.transformOrigin = '0 0'
    mount.style.transform = 'none'
    const box = pages.getBoundingClientRect()
    const m = mount.getBoundingClientRect()
    const r1 = focus.getBoundingClientRect()
    // End: the grid scaled to fit and centred in the pane (a point p maps
    // to m + k·(p − m) + t). Start: the written page exactly where it was.
    const k1 = best.k
    const end = { k: k1, x: (W - k1 * box.width) / 2 - m.left - k1 * (box.left - m.left), y: (H - k1 * box.height) / 2 - m.top - k1 * (box.top - m.top) }
    const k0 = r0.width / r1.width
    const start = { k: k0, x: r0.left - m.left - k0 * (r1.left - m.left), y: r0.top - m.top - k0 * (r1.top - m.top) }
    Reflect.set(window, '__mkSpread', { start, end })
  })
}

async function renderSpread(page: Page, e: number): Promise<void> {
  await page.frameLocator('iframe').first().locator('#mount').evaluate((mount: HTMLElement, p: number) => {
    const spread: unknown = Reflect.get(window, '__mkSpread')
    if (typeof spread !== 'object' || spread === null) throw new Error('spread not prepared')
    const read = (key: string) => {
      const v: unknown = Reflect.get(spread, key)
      const num = (k: string) => {
        const n: unknown = typeof v === 'object' && v !== null ? Reflect.get(v, k) : 0
        return typeof n === 'number' ? n : 0
      }
      return { k: num('k'), x: num('x'), y: num('y') }
    }
    const a = read('start')
    const b = read('end')
    // Steady zoom (geometric in scale); the offset follows the scale, so
    // the move is a zoom about one fixed point.
    const k = a.k * Math.pow(b.k / a.k, p)
    const w = a.k === b.k ? p : (a.k - k) / (a.k - b.k)
    const x = a.x + (b.x - a.x) * w
    const y = a.y + (b.y - a.y) * w
    mount.style.transform = `translate(${x}px, ${y}px) scale(${k})`
  }, e)
}

test('Tour: write', async ({ page, editor, tour }) => {
  test.setTimeout(1_200_000)
  const { before, section, after } = writeSection(demo.markdown)
  const start = `${before.trimEnd()}\n\n${after}`
  await openReport(page, editor, start, noCover)
  await page.locator('.cm-scroller').first().evaluate((el: HTMLElement) => {
    el.scrollTop = 0
  })
  await followSection(page)
  const clip = await tour.clip('write')
  await clip.cursor(false)
  await clip.frame(6)
  for (const text of sectionSteps(section)) {
    await editor.page.setDocText(`${before}${text}\n\n${after}`)
    await settlePreview(page, 500)
    await page.locator('.cm-scroller').first().evaluate((el: HTMLElement) => {
      el.scrollTop = 0
    })
    await followSection(page)
    await clip.frame()
  }
  const written = `${before}${section.join('\n\n')}\n\n${after}`
  await expect.poll(() => editor.page.docText()).toBe(written)
  // The typed table is a real table on the page.
  const frame = page.frameLocator('iframe').first()
  await expect(frame.locator('#mount table', { hasText: 'Net revenue retention' }).first()).toBeAttached()
  await clip.frame(8)
  // Pull back to the whole report.
  await settlePreview(page, 1200)
  await prepareSpread(page)
  const steps = 16
  for (let i = 0; i <= steps; i++) {
    const p = i / steps
    await renderSpread(page, p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2)
    await page.waitForTimeout(120)
    await clip.frame()
  }
  // Every page of the report is on screen in the final spread.
  const offscreen = await frame.locator('#mount').evaluate(() => [...document.querySelectorAll('.pagedjs_page')]
    .filter((el) => {
      const r = el.getBoundingClientRect()
      return r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight - 76
    }).length)
  expect(offscreen).toBe(0)
  await clip.done({
    description: 'The executive summary typed in Markdown while its page renders live, then the preview pulls back to the whole Quaybridge report.',
    focus: await previewRect(page),
    endHold: 2
  })
})

test('Tour: header and footer', async ({ page, editor, tour }) => {
  test.setTimeout(600_000)
  const theme: unknown = typeof noCover === 'object' && noCover !== null ? noCover : {}
  const header: unknown = typeof theme === 'object' && theme !== null ? Reflect.get(theme, 'header') : null
  const footer: unknown = typeof theme === 'object' && theme !== null ? Reflect.get(theme, 'footer') : null
  const blank = (slot: unknown) => ({ ...(typeof slot === 'object' && slot !== null ? slot : {}), left: '', center: '', right: '' })
  await openReport(page, editor, demo.markdown, withTheme(noCover, { header: blank(header), footer: blank(footer) }))
  await previewTo(page, 'table', 'Subscription')
  const clip = await tour.clip('rich')
  await clip.frame(10)

  await clip.click(editor.page.sidebar.theme, { after: () => expect(editor.page.theme.preset('arxiv')).toBeVisible() })
  await clip.frame(4)
  const section = (name: RegExp) => page.getByRole('button', { name }).first()
  const slot = (where: 'header' | 'footer', pos: 'Left' | 'Right') =>
    page.getByRole('region', { name: where === 'header' ? /^page header$/i : /^page footer$/i }).getByRole('textbox', { name: pos, exact: true })

  // Running header.
  await section(/^page header$/i).scrollIntoViewIfNeeded()
  await clip.click(section(/^page header$/i))
  await clip.frame(3)
  await clip.click(slot('header', 'Left'))
  await clip.type('Quaybridge · Q3 2026 quarterly report', 3)
  await settlePreview(page, 900)
  await clip.frame(8)

  // Footer: date on the left, page numbers on the right.
  await section(/^page footer$/i).scrollIntoViewIfNeeded()
  await clip.click(section(/^page footer$/i))
  await clip.frame(3)
  // The tokens are typed as text ({date}, {page}, {pages}); the chips under the fields insert the same.
  await clip.click(slot('footer', 'Left'))
  await clip.type('{date}', 2)
  await clip.click(slot('footer', 'Right'))
  await clip.type('{page} / {pages}', 3)
  await settlePreview(page, 1200)
  await clip.frame(6)
  // Show a page's top and bottom margins.
  const frame = page.frameLocator('iframe').first()
  await frame.locator('#mount .pagedjs_page').nth(2).evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'end' }))
  await page.waitForTimeout(400)
  const r = await previewRect(page)
  await clip.moveTo({ x: r.x + r.w * 0.5, y: r.y + r.h * 0.86 })
  await clip.frame(10)
  await frame.locator('#mount .pagedjs_page').nth(3).evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(400)
  await clip.moveTo({ x: r.x + r.w * 0.4, y: r.y + 40 })
  await clip.frame()
  await clip.done({
    description: 'A running header and a footer with the date and page numbers are added in the theme panel and appear on every page.',
    focus: r
  })
})

test('Tour: themes', async ({ page, editor, tour }) => {
  test.setTimeout(600_000)
  await openReport(page, editor, demo.markdown, noCover)
  await previewTo(page, '.mermaid')
  const clip = await tour.clip('themes')
  await clip.frame(8)
  await clip.click(editor.page.sidebar.theme, { after: () => expect(editor.page.theme.preset('business-report')).toBeVisible() })
  await clip.frame(3)

  // A different preset: the body pages restyle.
  await clip.click(editor.page.theme.preset('business-report'), {
    after: async () => {
      await settlePreview(page, 1600)
      await editor.page.setCoverEnabled(false)
      await editor.page.dismissToasts().catch(() => {})
      await previewTo(page, '.mermaid')
    }
  })
  await clip.frame(12)

  // Customise: an accent colour…
  const section = (name: RegExp) => page.getByRole('button', { name }).first()
  await section(/^colors$/i).scrollIntoViewIfNeeded()
  await clip.click(section(/^colors$/i))
  await clip.click(page.getByTestId('theme-color-brand-trigger'))
  // A new hue on the slider, then a deeper shade in the field.
  const hue = page.locator('[data-slot="track"]').first()
  await expect(hue).toBeVisible({ timeout: 5_000 })
  const track = await hue.boundingBox()
  if (track) await clip.click({ x: track.x + track.width / 2, y: track.y + track.height * 0.56 })
  const picker = page.locator('[data-slot="selector"]').first()
  const area = await picker.boundingBox()
  if (area) {
    await clip.click({ x: area.x + area.width * 0.82, y: area.y + area.height * 0.42 }, {
      after: async () => {
        await settlePreview(page, 1200)
        await previewTo(page, '.mermaid')
      }
    })
  }
  // Close the picker by its trigger (Escape would close the whole panel).
  await clip.click(page.getByTestId('theme-color-brand-trigger'))
  await clip.frame(10)

  // …and a different heading font.
  await section(/^headings$/i).scrollIntoViewIfNeeded()
  await clip.click(section(/^headings$/i))
  const fontPicker = page.getByRole('region', { name: /^headings$/i }).getByRole('combobox').first()
  await clip.click(fontPicker)
  await clip.type('Fraunces', 2)
  await page.keyboard.press('Enter')
  await settlePreview(page, 1400)
  await previewTo(page, '.mermaid')
  await clip.frame(12)

  // Last beat: the cover.
  await section(/^cover page$/i).scrollIntoViewIfNeeded()
  await clip.click(section(/^cover page$/i))
  await clip.click(editor.page.theme.coverEnabledSwitch, {
    after: async () => {
      await expect(page.frameLocator('iframe').first().locator('#mount .markoto-cover')).toHaveCount(1, { timeout: 15_000 })
      await settlePreview(page, 1200)
      await previewTo(page, '.markoto-cover')
    }
  })
  await clip.frame(4)
  await clip.done({
    description: 'A different preset restyles the report, then a new accent colour and heading font, and finally a designed cover page.',
    focus: await previewRect(page)
  })
})

test('Tour: share', async ({ page, editor, tour }) => {
  test.setTimeout(600_000)
  await openReport(page, editor, demo.markdown, noCover)
  await previewTo(page, '.mermaid')
  const clip = await tour.clip('share')
  await clip.frame(8)
  await clip.click(editor.page.accessLockButton, { after: () => expect(page.locator('[data-testid="share-modal"]')).toBeVisible() })
  await clip.frame(8)
  await clip.click(page.locator('[data-testid="share-qr-toggle"]'), {
    after: async () => {
      await expect(page.locator('[data-testid="share-qr-image-wrapper"] img')).toBeVisible()
      await page.waitForTimeout(400)
    }
  })
  await clip.frame(10)

  // The exported PDF (server-rendered), its pages drawn with pdf.js.
  const docId = editor.page.currentDocId()
  const origin = new URL(page.url()).origin
  const res = await page.request.get(`${origin}/api/docs/${docId}/pdf?inline=1`, { timeout: 120_000 })
  expect(res.ok(), `PDF export ${res.status()}`).toBe(true)
  const pdf = Buffer.from(await res.body())
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  const viewer = await page.context().newPage()
  await viewer.setViewportSize({ width: 2400, height: 1200 })
  await showPdf(viewer, `${origin}/__tour-pdf-viewer`, pdf, 5)
  const pagesDir = path.join(TOUR_OUTPUT, 'pdf-pages')
  await fs.mkdir(pagesDir, { recursive: true })
  const files: string[] = []
  // Summary (left), the key figures (centre, on top), the revenue chart (right).
  for (const n of [1, 2, 3]) {
    const file = path.join(pagesDir, `page-${n}.png`)
    await viewer.locator('canvas').nth(n).screenshot({ path: file })
    files.push(file)
  }
  await viewer.close()
  await clip.pages({
    id: 'sharePdf',
    t: [0.55, 1],
    description: 'Pages of the exported PDF fanned out over the share dialog.',
    files
  })
  await clip.done({
    description: 'The share dialog: the report link, its QR code and who may open it.',
    focus: page.locator('[data-testid="share-modal"]')
  })
})
