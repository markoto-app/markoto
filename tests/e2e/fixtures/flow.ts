import { test as base, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EditorPage } from '../page-objects/Editor'

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

export type Variant = 'light' | 'dark'

export type Manifest = {
  // Schema version so the Flow.vue component can guard against drift —
  // bump on any breaking change to entry shapes.
  version: 1
  title: string
  slug: string
  locale: string
  /** Color mode the app was rendering when this manifest was captured. */
  variant: Variant
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

export type EditorFixture = {
  /** Page-object with stable selectors + composite actions. */
  page: EditorPage
  /**
   * Run the canonical "homepage → New Document → wait for editor →
   * switch to split view" preamble AND record each step in the
   * manifest. Use this when doc creation IS the story (e.g. the
   * "Create a new document" flow). Writes one heading + one narrate
   * + four step entries.
   */
  recordPreamble: () => Promise<void>
  /**
   * Same preamble but writes nothing to the manifest. Use this when
   * the editor is just setup, not the subject — e.g. flows about
   * inserting tables, customizing themes. Faster for the reader who
   * doesn't need to see the doc-creation story repeated per page.
   */
  silentSetup: () => Promise<void>
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

export const test = base.extend<{ flow: Flow, editor: EditorFixture }>({
  flow: async ({ page }, use, testInfo) => {
    const locale = (testInfo.project.metadata?.locale as string | undefined) ?? 'en'
    const variant: Variant = (testInfo.project.metadata?.variant as Variant | undefined) ?? 'light'
    const slug = slugify(testInfo.title)
    const outDir = path.join('tests/e2e/output/flows', slug, locale, variant)
    await fs.mkdir(outDir, { recursive: true })

    // Force the app's color mode BEFORE any page script runs. We belt-
    // and-suspenders: project-level `colorScheme` sets the OS-level
    // prefers-color-scheme media query, AND we pre-seed the
    // nuxt-color-mode storage key so @nuxtjs/color-mode resolves to
    // the explicit preference instead of falling back to "system".
    // Either signal alone usually works; both together survive any
    // resolution-order change in the underlying color-mode plugin.
    await page.addInitScript((v: string) => {
      try { localStorage.setItem('nuxt-color-mode', v) } catch {}
    }, variant)

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

    // Hash → already-written filename. Lets us deduplicate identical
    // screenshots: a flow that adds a highlight + caption on top of an
    // unchanged frame should NOT write the same PNG twice. Two manifest
    // entries pointing at the same file render correctly in Flow.vue
    // (same image, different caption/cursor/highlights overlay) and
    // ship N× less bytes.
    const fileByHash = new Map<string, string>()

    const capture = async (caption: string, opts?: ShotOpts) => {
      if (suppress) { suppress = false; return }
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
      // Take the screenshot in-memory (no path) so we can hash it
      // and decide whether to write a new file or reuse an existing one.
      const buf = await page.screenshot({ fullPage: false })
      const hash = crypto.createHash('sha256').update(buf).digest('hex')
      let file = fileByHash.get(hash)
      if (!file) {
        // First time we've seen this frame — assign a fresh number,
        // write the file, remember the hash. Counter only increments
        // on actual writes so file numbering stays dense.
        counter += 1
        file = `${String(counter).padStart(2, '0')}.png`
        await fs.writeFile(path.join(outDir, file), buf)
        fileByHash.set(hash, file)
      } else {
        // Same pixels as a previous shot — point this entry at the
        // existing file. Print a notice so the author can decide if
        // the duplicate step is intentional (highlight-only update)
        // or accidental (back-to-back shots with no real change).
        console.log(`[flow] "${caption}" reuses ${file} (no visual change since last shot)`)
      }
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
      variant,
      viewport: { w: viewportSize.width, h: viewportSize.height },
      entries
    }
    await fs.writeFile(
      path.join(outDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    )
  },

  editor: async ({ page, flow }, use) => {
    // The page-object is created lazily — flows that don't call
    // recordPreamble() / silentSetup() can still query selectors via
    // editor.page.titleButton etc. (Useful for tests that navigate to
    // an existing doc rather than creating a new one.)
    const editor = new EditorPage(page)

    const fixture: EditorFixture = {
      page: editor,

      recordPreamble: async () => {
        // Canonical creation story. Captions/narration are kept generic
        // here because they're SHARED across every flow that records
        // the preamble. If a specific flow wants different copy, it
        // should call silentSetup() instead and write its own preamble.
        await flow.heading('Creating your first document')
        await flow.narrate(
          'YPad lets you create a document anonymously — no signup needed. '
          + 'You can claim it later by linking an account.'
        )

        await flow.step('Open the YPad homepage', async () => {
          await page.goto('/')
          // Wait for the hero CTA before continuing — guards against
          // capturing a mid-FOUC homepage.
          await page.getByRole('button', { name: /new document/i }).waitFor()
        })

        await flow.narrate(
          'The hero pitch + "New Document" button is the funnel for anonymous '
          + 'visitors. Logged-in users also see "New Workspace" alongside.'
        )

        await flow.step('Click "New Document" to spin up a fresh anonymous doc', async () => {
          // Click + URL-wait in parallel so we don't race a fast
          // navigation (which would complete before waitForURL armed).
          await Promise.all([
            page.waitForURL(/\/d\/[^/]+/),
            page.getByRole('button', { name: /new document/i }).click()
          ])
        })

        await flow.step('The editor mounts and Hocuspocus connects', async () => {
          await editor.waitForReady()
        })

        await flow.heading('Switching to split view', 3)
        await flow.narrate(
          'New docs land in preview mode briefly while the read-only flag '
          + 'resolves. Click the split-view icon (middle of the three view '
          + 'toggles) to see editor + preview side by side.'
        )

        await flow.step('Click the split-view toggle (middle icon)', async () => {
          await editor.switchToSplitView()
        })
      },

      silentSetup: async () => {
        await page.goto('/')
        await Promise.all([
          page.waitForURL(/\/d\/[^/]+/),
          page.getByRole('button', { name: /new document/i }).click()
        ])
        await editor.waitForReady()
        await editor.switchToSplitView()
      }
    }

    await use(fixture)
  }
})

export const expect = base.expect

/**
 * Skip the current test if its project's variant is in the opt-out
 * list. Use for flows where dual-mode capture is wasteful — e.g. a
 * flow that demonstrates the theme toggle itself; recording it in
 * "dark mode" is trivially the same content with reversed icon
 * order.
 *
 * Place at the top of a test:
 *
 *   test('Demo', async ({ flow, editor }, info) => {
 *     skipVariants(info, ['dark'], 'this flow demos light mode only')
 *     // ...
 *   })
 */
export function skipVariants(
  info: { project: { metadata?: Record<string, unknown> } },
  variants: Variant[],
  reason: string
): void {
  const v = info.project.metadata?.variant as Variant | undefined
  if (v && variants.includes(v)) {
    base.skip(true, `${reason} (skipping variant=${v})`)
  }
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export type { Page }
