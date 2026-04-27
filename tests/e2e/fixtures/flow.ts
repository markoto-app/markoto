import { test as base, expect as baseExpect, type Locator, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EditorPage } from '../page-objects/Editor'

// One Playwright fixture that turns a normal e2e test into a "flow":
// a sequence of slides — chapter, narration, approach, outcome — that
// the docs site embeds via <Flow id="..."/>. Each click captures TWO
// shots (approach: cursor-on-target/before; outcome: state-changed/
// after) so every action has a visible consequence. Chains opt out of
// the outcome shot via { chain: true }.
//
// Cursor tracking: we inject a mousemove/down listener on every page
// that stashes the last-known {x, y} on window.__flowCursor. Before
// each screenshot we read it back via page.evaluate. Coordinates are
// in CSS pixels relative to the viewport (the manifest carries
// viewport size at root, so the consumer can scale).
//
// i18n: each Playwright project declares `metadata: { locale: '<code>' }`;
// the fixture reads it via testInfo.project.metadata and writes to
// tests/e2e/output/flows/<slug>/<locale>/ so each locale gets its own
// screenshots + captions. Translators edit each locale's manifest in
// isolation.

type ChapterEntry = {
  kind: 'chapter'
  text: string
  level: 2 | 3
}

type NarrationEntry = {
  kind: 'narration'
  text: string
  file: string
  cursor: { x: number, y: number } | null
  path: string
}

type ApproachEntry = {
  kind: 'approach'
  file: string
  caption: string
  cursor: { x: number, y: number } | null
  path: string
}

type OutcomeEntry = {
  kind: 'outcome'
  file: string
  caption: string
  cursor: { x: number, y: number } | null
  path: string
  highlights?: Array<{ label: string, x: number, y: number, w: number, h: number }>
}

export type FlowEntry = ChapterEntry | NarrationEntry | ApproachEntry | OutcomeEntry

export type HighlightRef = { label: string, selector: string }

export type Variant = 'light' | 'dark'

export type Manifest = {
  // Schema version. v2 introduces approach/outcome/chapter/narration
  // kinds. The Flow.vue component reads this and refuses unknown
  // versions (defensive — keeps old artefacts from rendering wrong).
  version: 2
  title: string
  slug: string
  locale: string
  /** Color mode the app was rendering when this manifest was captured. */
  variant: Variant
  // Source viewport size — the consumer scales cursor coordinates by
  // (display_w / viewport.w) so overlays land in the right spot at
  // any displayed size.
  viewport: { w: number, h: number }
  entries: FlowEntry[]
}

// `flow.click` opts: discriminated union forces authors to either
// supply a `result` (becomes the outcome caption) or explicitly
// opt into chaining (no outcome shot — the next step's approach
// IS the after-state of this one). TS errors out on a bare click
// without one of these — by design.
export type ClickOpts =
  | {
    /** Caption for the outcome shot — declarative ("Editor opens"). */
    result: string
    /** Highlight callouts overlaid on the outcome shot only. */
    highlights?: HighlightRef[]
    /** Optional async to await between click and outcome screenshot
     *  (e.g. waitForURL on a navigating click). */
    after?: () => Promise<void>
    chain?: false
  }
  | {
    /** Skip the outcome shot — the next slide's approach is this
     *  click's after-state. Use sparingly; the default is "show me
     *  the consequence of every action". */
    chain: true
    after?: () => Promise<void>
  }

export type TypeOpts = {
  result: string
  highlights?: HighlightRef[]
  after?: () => Promise<void>
}

export type ShotOpts = { highlights?: HighlightRef[] }
export type HoverOpts = { highlights?: HighlightRef[] }

export type Flow = {
  /** Run an action then auto-screenshot as an OUTCOME with caption. */
  step: (caption: string, action: () => Promise<void>, opts?: ShotOpts) => Promise<void>
  /** Standalone OUTCOME screenshot (no action). Use for "look at this state". */
  shot: (caption: string, opts?: ShotOpts) => Promise<void>
  /**
   * Click-and-show: hover → screenshot APPROACH (cursor on target,
   * imperative caption) → click → optional `after` await → screenshot
   * OUTCOME (state changed, declarative `result` caption, same cursor
   * coords). Pass `chain: true` to skip the outcome when the next
   * step's approach already represents this click's consequence.
   */
  click: (caption: string, locator: Locator, opts: ClickOpts) => Promise<void>
  /**
   * Type-and-show: focus the input → screenshot APPROACH (cursor
   * inside, imperative "Type X" caption) → press the text → screenshot
   * OUTCOME (text in input, declarative `result` caption).
   */
  type: (caption: string, locator: Locator, text: string, opts: TypeOpts) => Promise<void>
  /** Hover (no click) → screenshot APPROACH. For "hover X to reveal Y". */
  hover: (caption: string, locator: Locator, opts?: HoverOpts) => Promise<void>
  /** Narration slide — text overlay on a captured screenshot, cursor hidden. */
  narrate: (text: string) => Promise<void>
  /** Chapter card — text-only slide, no screenshot, no cursor. */
  heading: (text: string, level?: 2 | 3) => Promise<void>
  /** Suppress the next auto-screenshot (transient mid-fade states). */
  skipNext: () => void
}

export type EditorFixture = {
  /** Page-object with stable selectors + composite actions. */
  page: EditorPage
  /**
   * Run the canonical "homepage → New Document" preamble AND record
   * each step in the manifest. Use this when doc creation IS the
   * story. Stops at the dialog being visible.
   */
  recordPreamble: () => Promise<void>
  /**
   * Same preamble but writes nothing to the manifest. Used when the
   * editor is just setup, not the subject.
   */
  silentSetup: () => Promise<void>
}

const CURSOR_INIT_SCRIPT = `
  (() => {
    if (window.__flowCursorInstalled) return
    window.__flowCursorInstalled = true
    window.__flowCursor = null
    window.__flowCursorPath = null
    const update = (e) => {
      if (typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return
      window.__flowCursor = { x: e.clientX, y: e.clientY }
      window.__flowCursorPath = location.pathname
    }
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

    await page.addInitScript((v: string) => {
      try { localStorage.setItem('nuxt-color-mode', v) } catch {}
    }, variant)

    await page.addInitScript(() => {
      const css = `
        #nuxt-devtools-container,
        #nuxt-devtools-anchor,
        iframe[src*="__nuxt_devtools__"],
        [data-v-inspector-container] { display: none !important; }
      `
      const inject = () => {
        const style = document.createElement('style')
        style.textContent = css
        ;(document.head || document.documentElement).appendChild(style)
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject, { once: true })
      } else {
        inject()
      }
    })

    await page.addInitScript(CURSOR_INIT_SCRIPT)
    page.on('framenavigated', () => {
      page.evaluate(CURSOR_INIT_SCRIPT).catch(() => {})
    })

    const viewportSize = page.viewportSize() ?? { width: 1280, height: 800 }
    const entries: FlowEntry[] = []
    let counter = 0
    let suppress = false

    const settle = async () => {
      // Pause briefly so CSS transitions finish before the screenshot.
      // We deliberately do NOT use waitForLoadState('networkidle') —
      // editor pages run a long-lived Y.js WebSocket so they never
      // hit networkidle in practice.
      await page.waitForTimeout(150)
    }

    const readCursor = async (
      opts: { formSnap?: boolean } = {}
    ): Promise<{ x: number, y: number } | null> => {
      try {
        // Form-field snap: when enabled, if focus is on an input/
        // textarea/contenteditable, override to the field's left-edge
        // midpoint. Used by flow.type so typing screenshots place the
        // cursor INSIDE the input. Disabled by flow.click + flow.hover —
        // those want the cursor on the locator we just hovered, not on
        // a stale focused field from a previous step.
        const formSnap = opts.formSnap ?? false
        return await page.evaluate((snap: boolean) => {
          if (snap) {
            const ae = document.activeElement as HTMLElement | null
            if (ae && ae !== document.body && ae !== document.documentElement) {
              const tag = ae.tagName
              const role = ae.getAttribute('role')
              const isFormish = tag === 'INPUT' || tag === 'TEXTAREA'
                || ae.isContentEditable
                || role === 'combobox' || role === 'textbox'
              if (isFormish) {
                const r = ae.getBoundingClientRect()
                const vw = window.innerWidth
                const vh = window.innerHeight
                const inViewport = r.width > 0 && r.height > 0
                  && r.top >= 0 && r.left >= 0
                  && r.bottom <= vh && r.right <= vw
                if (inViewport) {
                  return { x: Math.round(r.left + 14), y: Math.round(r.top + r.height / 2) }
                }
              }
            }
          }
          const w = window as unknown as { __flowCursor: { x: number, y: number } | null, __flowCursorPath: string | null }
          if (!w.__flowCursor) return null
          if (w.__flowCursorPath !== location.pathname) return null
          return w.__flowCursor
        }, formSnap)
      } catch {
        return null
      }
    }

    const STRICT_HIGHLIGHTS = process.env.FLOW_STRICT === '1' || process.env.CI === 'true'

    const resolveHighlights = async (refs: HighlightRef[] | undefined) => {
      if (!refs?.length) return undefined
      const out: NonNullable<OutcomeEntry['highlights']> = []
      for (const ref of refs) {
        const loc = page.locator(ref.selector).first()
        const box = await loc.boundingBox().catch(() => null)
        if (!box) {
          const msg = `[flow] highlight "${ref.label}" — selector \`${ref.selector}\` resolved to no visible box`
          if (STRICT_HIGHLIGHTS) {
            throw new Error(`${msg} (FLOW_STRICT/CI is set — failing)`)
          }
          console.warn(`${msg}; skipping (set FLOW_STRICT=1 to fail)`)
          continue
        }
        out.push({ label: ref.label, x: box.x, y: box.y, w: box.width, h: box.height })
      }
      return out.length ? out : undefined
    }

    // Hash → already-written filename. Identical screenshots share a
    // single PNG on disk; multiple manifest entries can reference one
    // file (different captions/cursors over the same pixels).
    const fileByHash = new Map<string, string>()

    type CaptureMode = 'narration' | 'approach' | 'outcome'

    const captureFrame = async (
      mode: CaptureMode,
      caption: string,
      opts: {
        highlights?: HighlightRef[]
        cursor?: { x: number, y: number } | null
        /** Apply readCursor's form-field snap. True for flow.type +
         *  flow.shot/step (outcomes that may follow typing); false for
         *  flow.click + flow.hover (cursor must follow the locator). */
        formSnap?: boolean
      } = {}
    ) => {
      if (suppress) { suppress = false; return }
      await settle()
      // For approach/narration: read cursor live. For outcome: caller
      // passes the approach's cursor coords explicitly so the cursor
      // stays put across the click (Playwright's pointer doesn't move
      // between hover and click, but SPA navigation invalidates the
      // URL stamp — passing it through bypasses the staleness check).
      const cursor = opts.cursor !== undefined ? opts.cursor : await readCursor({ formSnap: opts.formSnap })
      const url = (() => {
        try { return new URL(page.url()) } catch { return null }
      })()
      const shotPath = url && url.protocol.startsWith('http') ? `${url.pathname}${url.search}` : '/'
      const highlights = mode === 'outcome' ? await resolveHighlights(opts.highlights) : undefined
      const buf = await page.screenshot({ fullPage: false })
      const hash = crypto.createHash('sha256').update(buf).digest('hex')
      let file = fileByHash.get(hash)
      if (!file) {
        counter += 1
        file = `${String(counter).padStart(2, '0')}.png`
        await fs.writeFile(path.join(outDir, file), buf)
        fileByHash.set(hash, file)
      } else {
        console.log(`[flow] "${caption}" reuses ${file} (no visual change since last shot)`)
      }
      if (mode === 'narration') {
        entries.push({ kind: 'narration', text: caption, file, cursor, path: shotPath })
      } else if (mode === 'approach') {
        entries.push({ kind: 'approach', file, caption, cursor, path: shotPath })
      } else {
        entries.push({ kind: 'outcome', file, caption, cursor, path: shotPath, highlights })
      }
    }

    const flow: Flow = {
      step: async (caption, action, opts) => {
        await action()
        // formSnap=true: an action may have left focus on an input
        // (e.g. typing) — render cursor inside the field rather than
        // at a stale mousemove location.
        await captureFrame('outcome', caption, { highlights: opts?.highlights, formSnap: true })
      },
      shot: async (caption, opts) => {
        await captureFrame('outcome', caption, { highlights: opts?.highlights, formSnap: true })
      },
      click: async (caption, locator, opts) => {
        await locator.scrollIntoViewIfNeeded().catch(() => {})
        await locator.hover()
        // Approach: cursor on the locator we just hovered. formSnap=false
        // so a previously-focused input doesn't pull the cursor away
        // from the click target (the textarea-vs-Submit gotcha).
        const approachCursor = await readCursor({ formSnap: false })
        await captureFrame('approach', caption, { cursor: approachCursor })
        await locator.click()
        if (opts.after) await opts.after()
        if ('chain' in opts && opts.chain) return
        // Outcome uses the same cursor coords (the user's hand didn't
        // teleport). After SPA nav, readCursor would return null due
        // to the URL-stamp guard — passing the saved coords keeps the
        // cursor visible across the click.
        await captureFrame('outcome', (opts as { result: string }).result, {
          highlights: (opts as { highlights?: HighlightRef[] }).highlights,
          cursor: approachCursor
        })
      },
      type: async (caption, locator, text, opts) => {
        await locator.scrollIntoViewIfNeeded().catch(() => {})
        // Click into the field so it's focused — cursor snaps to its
        // left edge via readCursor's form-field rule.
        await locator.click()
        const approachCursor = await readCursor({ formSnap: true })
        await captureFrame('approach', caption, { cursor: approachCursor })
        await locator.pressSequentially(text)
        if (opts.after) await opts.after()
        await captureFrame('outcome', opts.result, {
          highlights: opts.highlights,
          cursor: approachCursor
        })
      },
      hover: async (caption, locator, opts) => {
        await locator.scrollIntoViewIfNeeded().catch(() => {})
        await locator.hover()
        // formSnap=false — same reasoning as flow.click.
        await captureFrame('approach', caption, {
          highlights: opts?.highlights,
          formSnap: false
        })
      },
      narrate: async (text) => {
        // Narration hides the cursor at render — formSnap doesn't
        // matter visually, but using false keeps the recorded coords
        // consistent with where the user's last motion actually was.
        await captureFrame('narration', text, { formSnap: false })
      },
      heading: async (text, level = 2) => {
        entries.push({ kind: 'chapter', level, text })
      },
      skipNext: () => { suppress = true }
    }

    await use(flow)

    const manifest: Manifest = {
      version: 2,
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
    const editor = new EditorPage(page)

    const fixture: EditorFixture = {
      page: editor,

      recordPreamble: async () => {
        // Lean preamble for flows where doc creation IS the story.
        // Captions are user-voice — no implementation jargon.
        await flow.step('Open YPad', async () => {
          await page.goto('/')
          await page.getByRole('button', { name: /new document/i }).waitFor()
        })

        // Vue hydration race: SSR makes the "+ New Document" button look
        // interactive immediately, but its @click handler may not have
        // attached yet. A single click can be a no-op. We use the same
        // toPass retry pattern as silentSetup — converge on "dialog
        // visible" rather than hoping one click took.
        //
        // Split the action into hover (captures approach shot, cursor
        // on target) → toPass retry (clicks until dialog opens, no
        // captures) → flow.shot (captures outcome). flow.click would
        // bake a single click into the action; we need retries.
        const newDocBtn = page.getByRole('button', { name: /new document/i })
        await flow.hover('Click "New Document" to start writing', newDocBtn)
        await baseExpect(async () => {
          await newDocBtn.click()
          await baseExpect(editor.newDocDialog.heading).toBeVisible({ timeout: 1500 })
        }).toPass({ timeout: 15_000 })
        await baseExpect(editor.newDocDialog.titleInput).toBeVisible()
        await flow.shot('The new-document dialog opens — five quick questions to set up your doc')
      },

      silentSetup: async () => {
        await page.goto('/')

        // Wait for Vue hydration before clicking — SSR makes the
        // button look interactive before its @click handler attaches.
        // expect.toPass converges on a stable post-condition (dialog
        // visible) rather than hoping a single click took.
        const newDocBtn = page.getByRole('button', { name: /new document/i })
        await newDocBtn.waitFor({ state: 'visible' })
        await baseExpect(async () => {
          await newDocBtn.click()
          await baseExpect(editor.newDocDialog.heading).toBeVisible({ timeout: 1500 })
        }).toPass({ timeout: 15_000 })
        await baseExpect(editor.newDocDialog.titleInput).toBeVisible()

        await Promise.all([
          page.waitForURL(/\/d\/[^/]+/),
          editor.newDocDialog.submitBlank.click()
        ])
        await editor.waitForReady()
        await editor.switchToSplitView()
        await editor.waitForPreviewPaginated()
      }
    }

    await use(fixture)
  }
})

export const expect = baseExpect

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
