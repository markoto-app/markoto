import fs from 'node:fs/promises'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { test as flowTest, expect } from '../fixtures/flow'
import type { TourBeatId, TourSceneId } from '../../../shared/tour/manifest'

// Product-tour capture fixture (WP11). Extends the flow fixture (same
// `editor` helpers, login shim, failure signals) with a
// `tour` recorder that turns a scripted session in the real app into the
// frames of a short looping video.
//
// Frames are taken STEP BY STEP — never with Playwright's screen recorder
// (blurry, low bitrate): the script drives the app, and after each step
// the recorder takes a 2x screenshot and decides how long that frame
// lasts on the video's fixed timeline (holds = one file with a duration).
// A virtual cursor is drawn INTO the page (a fixed element the recorder
// moves along eased paths to each target's centre, with a click ripple),
// so it ends up in the pixels; the real mouse follows it so hover states
// are real too.
//
// Output: `$TOUR_OUTPUT_DIR/<mode>/<scene>/` (default
// tests/e2e/output/tour) — PNG frames + `clip.json`. `scripts/capture-tour.ts`
// encodes them (AV1 + H.264, desktop + phone cut, posters) into
// public/tour/ and writes the manifest.

export type Rect = { x: number, y: number, w: number, h: number }
type Point = { x: number, y: number }
type Target = Locator | Rect | Point

export const TOUR_OUTPUT = process.env.TOUR_OUTPUT_DIR ?? 'tests/e2e/output/tour'
/** Frames per second of the video timeline. */
const TOUR_FPS = 12

export interface ClipDone {
  /** What the clip shows (capture notes; the page's alt text is i18n). */
  description: string
  /** Region the phone cut shows. */
  focus: Locator | Rect
  /** Seconds the last frame holds before the loop restarts (default 2). */
  endHold?: number
}

export interface Clip {
  /** Capture the current state as `frames` frames of the timeline. */
  frame: (frames?: number) => Promise<void>
  /** Keep showing the last frame for `seconds`. */
  hold: (seconds: number) => Promise<void>
  /** Glide the cursor to a target (eased), one captured frame per step. */
  moveTo: (target: Target, frames?: number) => Promise<void>
  /** Glide, then click for real with a ripple. `after` runs right after the click. */
  click: (target: Target, opts?: { frames?: number, after?: () => Promise<void> }) => Promise<void>
  /** Type into the focused element, `perFrame` characters per frame. */
  type: (text: string, perFrame?: number) => Promise<void>
  /** Capture a frame every `everyMs` while `until` is false (max `maxFrames`). */
  record: (until: () => Promise<boolean>, opts?: { everyMs?: number, maxFrames?: number }) => Promise<void>
  /** Hide / show the virtual cursor (e.g. while another actor works). */
  cursor: (visible: boolean) => Promise<void>
  /** Record a later beat of the scene: document pages (PNG files) that fan out over the video. */
  pages: (opts: { id: TourBeatId, t: [number, number], description: string, files: string[] }) => Promise<void>
  /** Write clip.json. */
  done: (opts: ClipDone) => Promise<void>
}

export interface TourRecorder {
  clip: (id: TourSceneId) => Promise<Clip>
}

function isLocator(t: unknown): t is Locator {
  return typeof t === 'object' && t !== null && typeof Reflect.get(t, 'boundingBox') === 'function'
}
function isRect(t: Target): t is Rect {
  return !isLocator(t) && 'w' in t
}

async function boxOf(target: Locator | Rect, pad = 0): Promise<Rect> {
  if (!isLocator(target)) return target
  const box = await target.first().boundingBox()
  if (!box) throw new Error(`[tour] element has no box: ${String(target)}`)
  return {
    x: Math.max(0, Math.round(box.x - pad)),
    y: Math.max(0, Math.round(box.y - pad)),
    w: Math.round(box.width + pad * 2),
    h: Math.round(box.height + pad * 2)
  }
}

async function pointOf(target: Target): Promise<Point> {
  if (isLocator(target) || isRect(target)) {
    const r = await boxOf(target)
    return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) }
  }
  return { x: Math.round(target.x), y: Math.round(target.y) }
}

function clampRect(r: Rect, vw: number, vh: number): Rect {
  const x = Math.min(Math.max(0, r.x), vw - 1)
  const y = Math.min(Math.max(0, r.y), vh - 1)
  return { x, y, w: Math.max(1, Math.min(r.w, vw - x)), h: Math.max(1, Math.min(r.h, vh - y)) }
}

function easeInOut(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2
}

// The virtual cursor: an arrow + a ripple ring, drawn above everything,
// ignored by the pointer. Re-installed on every navigation.
const CURSOR_SCRIPT = `
(() => {
  const install = () => {
    if (document.getElementById('mk-tour-cursor')) return
    const style = document.createElement('style')
    style.textContent = '#nuxt-devtools-container{display:none!important}'
      + '#mk-tour-cursor,#mk-tour-ripple{position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647}'
      + '#mk-tour-ripple{width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:999px;border:2px solid rgba(20,17,13,.55);background:rgba(20,17,13,.08);opacity:0}'
      + 'html.dark #mk-tour-ripple{border-color:rgba(250,248,244,.7);background:rgba(250,248,244,.1)}'
    document.head.appendChild(style)
    const ripple = document.createElement('div')
    ripple.id = 'mk-tour-ripple'
    const cursor = document.createElement('div')
    cursor.id = 'mk-tour-cursor'
    cursor.innerHTML = '<svg width="26" height="30" viewBox="0 0 26 30" style="display:block;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35))"><path d="M2 1.5 L2 24 L7.6 18.9 L11.6 27.6 L15.3 26 L11.4 17.5 L18.8 17.5 Z" fill="#14110D" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>'
    cursor.style.transform = 'translate(' + (window.__mkCursor?.x ?? -60) + 'px,' + (window.__mkCursor?.y ?? -60) + 'px)'
    document.body.appendChild(ripple)
    document.body.appendChild(cursor)
  }
  if (document.body) install()
  else addEventListener('DOMContentLoaded', install)
})()
`

/** Stable, quiet frames: no caret blink, no CSS animation mid-flight. */
async function shoot(page: Page, file: string): Promise<void> {
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide', scale: 'device' })
}

export const test = flowTest.extend<{ tour: TourRecorder }>({
  tour: async ({ page }, use, testInfo) => {
    const mode = String(testInfo.project.metadata?.mode ?? 'light')
    const viewport = page.viewportSize() ?? { width: 1440, height: 900 }
    await page.addInitScript(CURSOR_SCRIPT)

    const recorder: TourRecorder = {
      clip: async (id) => {
        const dir = path.join(TOUR_OUTPUT, mode, id)
        await fs.rm(dir, { recursive: true, force: true })
        await fs.mkdir(dir, { recursive: true })
        const frames: Array<{ file: string, repeat: number }> = []
        const beats: Array<Record<string, unknown>> = []
        let pos: Point = { x: viewport.width * 0.62, y: viewport.height * 0.72 }
        let shown = true

        const place = async (p: Point, ripple: number | null = null) => {
          pos = p
          await page.mouse.move(p.x, p.y)
          await page.evaluate(({ x, y, r, visible }) => {
            Reflect.set(window, '__mkCursor', { x, y })
            const c = document.getElementById('mk-tour-cursor')
            if (c) {
              c.style.transform = `translate(${x}px, ${y}px)`
              c.style.display = visible ? 'block' : 'none'
            }
            const ring = document.getElementById('mk-tour-ripple')
            if (ring) {
              ring.style.transform = `translate(${x}px, ${y}px) scale(${r === null ? 0.3 : 0.4 + r * 1.2})`
              ring.style.opacity = r === null ? '0' : String(0.9 * (1 - r))
            }
          }, { x: p.x, y: p.y, r: ripple, visible: shown })
        }
        const frame = async (n = 1) => {
          const file = `f${String(frames.length).padStart(5, '0')}.png`
          await shoot(page, path.join(dir, file))
          frames.push({ file, repeat: Math.max(1, Math.round(n)) })
        }
        const moveTo = async (target: Target, steps = 9) => {
          const to = await pointOf(target)
          const from = pos
          for (let i = 1; i <= steps; i++) {
            const k = easeInOut(i / steps)
            await place({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k })
            await frame()
          }
        }
        // Make sure the cursor element sits where we think it is.
        await place(pos)

        const clip: Clip = {
          frame,
          hold: async (seconds) => {
            const last = frames[frames.length - 1]
            if (last) last.repeat += Math.max(1, Math.round(seconds * TOUR_FPS))
            else await frame(seconds * TOUR_FPS)
          },
          moveTo,
          click: async (target, opts = {}) => {
            await moveTo(target, opts.frames ?? 9)
            await page.mouse.down()
            await page.mouse.up()
            await opts.after?.()
            for (let r = 0; r < 5; r++) {
              await place(pos, r / 5)
              await frame()
            }
            await place(pos)
          },
          type: async (text, perFrame = 3) => {
            for (let i = 0; i < text.length; i += perFrame) {
              await page.keyboard.type(text.slice(i, i + perFrame))
              await frame()
            }
          },
          record: async (until, opts = {}) => {
            const every = opts.everyMs ?? 500
            const max = opts.maxFrames ?? 120
            for (let i = 0; i < max && !(await until()); i++) {
              await frame(Math.max(1, Math.round((every / 1000) * TOUR_FPS)))
              await page.waitForTimeout(every)
            }
          },
          cursor: async (visible) => {
            shown = visible
            await place(pos)
          },
          pages: async (opts) => {
            const files = []
            for (const [i, src] of opts.files.entries()) {
              const file = `page-${opts.id}-${i}.png`
              await fs.copyFile(src, path.join(dir, file))
              files.push(file)
            }
            beats.push({ id: opts.id, t: opts.t, description: opts.description, pages: files })
          },
          done: async (opts) => {
            const last = frames[frames.length - 1]
            if (last) last.repeat += Math.round((opts.endHold ?? 2) * TOUR_FPS)
            const focus = clampRect(await boxOf(opts.focus), viewport.width, viewport.height)
            const clipJson = {
              id,
              mode,
              fps: TOUR_FPS,
              viewport: { w: viewport.width, h: viewport.height },
              description: opts.description,
              focus,
              frames,
              ...(beats.length ? { beats } : {})
            }
            await fs.writeFile(path.join(dir, 'clip.json'), `${JSON.stringify(clipJson, null, 2)}\n`)
          }
        }
        return clip
      }
    }
    await use(recorder)
  }
})

/** The report's theme with the cover switched on or off (the committed theme.json stays untouched). */
export function withCover(theme: unknown, enabled: boolean): unknown {
  if (typeof theme !== 'object' || theme === null) return theme
  const cover: unknown = Reflect.get(theme, 'cover')
  return { ...theme, cover: { ...(typeof cover === 'object' && cover !== null ? cover : {}), enabled } }
}

/** Override top-level sections of a theme (e.g. empty header/footer). */
export function withTheme(theme: unknown, patch: Record<string, unknown>): unknown {
  if (typeof theme !== 'object' || theme === null) return theme
  return { ...theme, ...patch }
}
export { expect }

/** Wait for the preview to re-render after an edit and settle (mermaid, KaTeX, pagination). */
export async function settlePreview(page: Page, ms = 900): Promise<void> {
  await page.waitForTimeout(ms)
  await page.frameLocator('iframe').first().locator('#mount .pagedjs_page').first().waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(250)
}

/** Apply a whole DocTheme live (ymeta.theme, exactly what the Theme panel writes) and persist it. */
export async function applyTheme(page: Page, theme: unknown): Promise<void> {
  const docId = /\/d\/([^/?]+)/.exec(new URL(page.url()).pathname)?.[1]
  if (!docId) throw new Error('[applyTheme] not on a document')
  const res = await page.request.put(`/api/docs/${docId}/meta`, { data: { theme } })
  if (!res.ok()) throw new Error(`[applyTheme] PUT /meta → ${res.status()}: ${await res.text()}`)
  const applied = await page.evaluate((t: unknown) => {
    const ydoc: unknown = Reflect.get(globalThis, '__DEBUG_ydoc')
    if (typeof ydoc !== 'object' || ydoc === null) return false
    const getMap: unknown = Reflect.get(ydoc, 'getMap')
    if (typeof getMap !== 'function') return false
    const meta: unknown = getMap.call(ydoc, 'meta')
    if (typeof meta !== 'object' || meta === null) return false
    const set: unknown = Reflect.get(meta, 'set')
    if (typeof set !== 'function') return false
    set.call(meta, 'theme', t)
    return true
  }, theme)
  if (!applied) throw new Error('[applyTheme] window.__DEBUG_ydoc is missing — run against the flow stack')
}

/**
 * The hosted shape of AI: the signed-in user's own provider (bring your
 * own key). Saves the user's Mistral key through the real settings API
 * (verified by a test call), so the instance pays for nothing and the
 * app shows no AI-points meter — exactly what markoto.app users see.
 */
export async function useOwnMistralKey(page: Page): Promise<void> {
  const apiKey = process.env.MISTRAL_API_KEY
  if (!apiKey) throw new Error('[useOwnMistralKey] MISTRAL_API_KEY is not set')
  const res = await page.request.put('/api/user/ai-providers/chat', {
    data: { baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-2603', apiKey, supportsVision: true }
  })
  if (!res.ok()) throw new Error(`[useOwnMistralKey] save failed: ${res.status()}`)
}

/**
 * Bring the editor line containing `text` into view in a long document.
 * CodeMirror only renders lines near the viewport, so first jump to the
 * matching position (by its share of the document), then centre the line.
 */
export async function editorTo(page: Page, text: string | RegExp): Promise<void> {
  const doc = await page.evaluate(() => {
    const ytext: unknown = Reflect.get(globalThis, '__DEBUG_ytext')
    if (typeof ytext !== 'object' || ytext === null) return ''
    const toText: unknown = Reflect.get(ytext, 'toString')
    return typeof toText === 'function' ? String(toText.call(ytext)) : ''
  })
  const index = typeof text === 'string' ? doc.indexOf(text) : doc.search(text)
  const share = doc.length > 0 && index >= 0 ? index / doc.length : 0
  const line = page.locator('.cm-line', { hasText: text }).first()
  for (let attempt = 0; attempt < 6 && !(await line.count()); attempt++) {
    await page.locator('.cm-scroller').first().evaluate((el: HTMLElement, s: number) => {
      el.scrollTop = Math.max(0, s * el.scrollHeight - el.clientHeight / 2)
    }, share)
    await page.waitForTimeout(300)
  }
  await expect(line).toBeAttached({ timeout: 10_000 })
  await line.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(200)
}
