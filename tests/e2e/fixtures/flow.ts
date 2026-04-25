import { test as base, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

// One Playwright fixture that turns a normal e2e test into a "flow":
// a sequence of screenshots + captions + narration that the docs site
// embeds via <Flow id="..."/>. The fixture writes one manifest per test
// + the PNG frames; everything else (rendering, layout, video) is the
// docs consumer's problem.
//
// Cursor tracking: we inject a mousemove/down listener on every page
// that stashes the last-known {x, y} on window.__flowCursor. Before each
// screenshot we read it back via page.evaluate. Coordinates are in CSS
// pixels relative to the viewport (the manifest carries viewport size
// at root, so the consumer can scale).
//
// i18n: each Playwright project declares `metadata: { locale: '<code>' }`;
// the fixture reads it via testInfo.project.metadata and writes to
// tests/e2e/output/flows/<slug>/<locale>/ so each locale gets its own
// screenshots + captions. Translators edit each locale's manifest in
// isolation.

type ShotEntry = {
  kind: 'shot'
  file: string
  caption: string
  cursor: { x: number, y: number } | null
  // URL pathname + search at screenshot time. Stored RELATIVE to the
  // baseURL (so just the path, not the full URL) — the docs site can
  // render its own base in the address bar and the manifest stays
  // portable across environments.
  path: string
  // Optional bounding-box callouts: dashed outlines + labels overlaid
  // on the screenshot to draw attention to specific UI elements
  // (e.g. "Word count", "Sync status"). Coordinates are CSS pixels
  // relative to the viewport — same scheme as `cursor` — so the
  // consumer can scale them by `displayed / viewport.w/h`.
  highlights?: Array<{ label: string, x: number, y: number, w: number, h: number }>
}

export type HighlightRef = { label: string, selector: string }
export type ShotOpts = { highlights?: HighlightRef[] }
type NarrateEntry = { kind: 'narrate', text: string }
type HeadingEntry = { kind: 'heading', level: 2 | 3, text: string }
export type FlowEntry = ShotEntry | NarrateEntry | HeadingEntry

export type Manifest = {
  // Schema version so the Flow.vue component can guard against drift —
  // bump on any breaking change to entry shapes.
  version: 1
  title: string
  slug: string
  locale: string
  // Source viewport size — the consumer scales cursor coordinates by
  // (display_w / viewport.w) so overlays land in the right spot at any
  // displayed size.
  viewport: { w: number, h: number }
  entries: FlowEntry[]
}

export type Flow = {
  /** Run an action then auto-screenshot with a caption. */
  step: (caption: string, action: () => Promise<void>, opts?: ShotOpts) => Promise<void>
  /** Screenshot WITHOUT an action — for "look at this state" moments. */
  shot: (caption: string, opts?: ShotOpts) => Promise<void>
  /** Prose between images; rendered as a narration block in the docs. */
  narrate: (text: string) => Promise<void>
  /** Section break; rendered as ## / ### in the docs. */
  heading: (text: string, level?: 2 | 3) => Promise<void>
  /** Suppress the next auto-screenshot (transient states like mid-fade modals). */
  skipNext: () => void
}

const CURSOR_INIT_SCRIPT = `
  (() => {
    if (window.__flowCursorInstalled) return
    window.__flowCursorInstalled = true
    window.__flowCursor = null
    const update = (e) => {
      // PointerEvent on touch may not have clientX/Y for synthetic events —
      // skip those so we don't overwrite a real position with nothing.
      if (typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return
      window.__flowCursor = { x: e.clientX, y: e.clientY }
    }
    // capture phase so we win even if a stopPropagation handler is downstream.
    addEventListener('mousemove', update, true)
    addEventListener('mousedown', update, true)
    addEventListener('mouseup', update, true)
    addEventListener('pointermove', update, true)
    addEventListener('pointerdown', update, true)
  })()
`

export const test = base.extend<{ flow: Flow }>({
  flow: async ({ page }, use, testInfo) => {
    const locale = (testInfo.project.metadata?.locale as string | undefined) ?? 'en'
    const slug = slugify(testInfo.title)
    const outDir = path.join('tests/e2e/output/flows', slug, locale)
    await fs.mkdir(outDir, { recursive: true })

    // Inject cursor tracking on every page in this context.
    await page.addInitScript(CURSOR_INIT_SCRIPT)
    page.on('framenavigated', () => {
      // After full page navigations the init script re-runs automatically,
      // but cross-origin iframes etc. don't — re-add as a safety net. The
      // script is idempotent (guarded by __flowCursorInstalled).
      page.evaluate(CURSOR_INIT_SCRIPT).catch(() => {})
    })

    const viewportSize = page.viewportSize() ?? { width: 1920, height: 1080 }
    const entries: FlowEntry[] = []
    let counter = 0
    let suppress = false

    const settle = async () => {
      // Wait for the page to settle before snapping. networkidle covers
      // most async content; the small explicit timeout lets CSS transitions
      // (modal fades, dropdown slides) finish so we don't capture mid-frame.
      await page.waitForLoadState('networkidle').catch(() => {})
      await page.waitForTimeout(150)
    }

    const readCursor = async (): Promise<{ x: number, y: number } | null> => {
      try {
        return await page.evaluate(() => (window as any).__flowCursor ?? null)
      } catch {
        return null
      }
    }

    const resolveHighlights = async (refs: HighlightRef[] | undefined) => {
      if (!refs?.length) return undefined
      const out: NonNullable<ShotEntry['highlights']> = []
      for (const ref of refs) {
        // .first() guards against multi-match ambiguity — log it but
        // proceed; flow authors usually mean the first occurrence.
        const loc = page.locator(ref.selector).first()
        const box = await loc.boundingBox().catch(() => null)
        if (!box) {
          // Skip silently in the manifest; print a console line so the
          // test output makes the miss visible to the author.
          console.warn(`[flow] highlight "${ref.label}" — selector \`${ref.selector}\` resolved to no visible box; skipping`)
          continue
        }
        out.push({ label: ref.label, x: box.x, y: box.y, w: box.width, h: box.height })
      }
      return out.length ? out : undefined
    }

    const capture = async (caption: string, opts?: ShotOpts) => {
      if (suppress) { suppress = false; return }
      counter += 1
      const file = `${String(counter).padStart(2, '0')}.png`
      await settle()
      const cursor = await readCursor()
      // Capture URL path AFTER settle so any in-flight navigation has
      // committed. about:blank etc. (no real path) collapses to '/'.
      const url = (() => {
        try { return new URL(page.url()) } catch { return null }
      })()
      const shotPath = url && url.protocol.startsWith('http') ? `${url.pathname}${url.search}` : '/'
      // Resolve highlight selectors → bounding boxes BEFORE the
      // screenshot so we capture the layout exactly as photographed
      // (a slow async could let the page reflow between snap and probe).
      const highlights = await resolveHighlights(opts?.highlights)
      await page.screenshot({ path: path.join(outDir, file), fullPage: false })
      entries.push({ kind: 'shot', file, caption, cursor, path: shotPath, highlights })
    }

    const flow: Flow = {
      step: async (caption, action, opts) => { await action(); await capture(caption, opts) },
      shot: capture,
      narrate: async (text) => { entries.push({ kind: 'narrate', text }) },
      heading: async (text, level = 2) => { entries.push({ kind: 'heading', level, text }) },
      skipNext: () => { suppress = true }
    }

    await use(flow)

    const manifest: Manifest = {
      version: 1,
      title: testInfo.title,
      slug,
      locale,
      viewport: { w: viewportSize.width, h: viewportSize.height },
      entries
    }
    await fs.writeFile(
      path.join(outDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    )
  }
})

export const expect = base.expect

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export type { Page }
