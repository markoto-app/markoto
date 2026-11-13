import createDOMPurify from 'dompurify'
import { MERMAID_URL, MERMAID_SRI } from '~~/shared/utils/vendor/mermaidAssets'

/**
 * Mermaid for a document that renders in its own top-level context: the
 * server render page (`app/pages/_internal/render/[docId].vue`, loaded by
 * the renderer sidecar's Chromium). The live preview and the browser
 * print path render mermaid INSIDE their sandboxed iframe instead
 * (pagedPreviewIframe.html, which carries the same steps), so diagram
 * source never runs through mermaid in the app's origin.
 *
 * Two phases, because paged.js and inline SVG don't mix:
 *   1. `transformMermaid` (before pagination) renders each diagram with
 *      the document's config (`shared/utils/markdown/mermaidConfig.ts`) and puts
 *      it in the page as an `<img data:image/svg+xml>` with explicit
 *      width/height. An image is atomic for paged.js; an inline SVG gets
 *      split across pages.
 *   2. `inlineMermaidSvgs` (after pagination) swaps each of those images
 *      for the SVG itself, sanitised with DOMPurify's SVG profile. An SVG
 *      loaded as an image cannot use the page's web fonts (no external
 *      resources), so without this step chart text falls back to a
 *      generic font with different metrics. Inline, the text is set in
 *      the document's body font and stays real (selectable) text in the
 *      PDF. The image box is kept as the SVG's box, so the layout paged.js
 *      computed doesn't move.
 *
 * Mermaid is the SRI-locked single-file build injected as a classic
 * `<script integrity crossorigin>` (see shared/utils/vendor/mermaidAssets.ts), the
 * ESM build's dynamic `import()` cannot be integrity-checked.
 */

// Only `initialize` and `render` are used; a minimal interface avoids `any`.
interface MermaidModule {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, source: string) => Promise<{ svg: string }>
}

export interface MermaidRenderOptions {
  /** `buildMermaidConfig(theme)` (shared/utils/markdown/mermaidConfig.ts). */
  config: Record<string, unknown>
  /** BCP-47 tag of the document language, for number formats. */
  locale: string
}

function isMermaidModule(value: unknown): value is MermaidModule {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.initialize === 'function' && typeof v.render === 'function'
}

let mermaidPromise: Promise<MermaidModule> | null = null

function loadMermaidScript(): Promise<MermaidModule> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = MERMAID_URL
    script.integrity = MERMAID_SRI
    script.crossOrigin = 'anonymous'
    script.onload = () => {
      const m: unknown = Reflect.get(globalThis, 'mermaid')
      if (isMermaidModule(m)) resolve(m)
      else reject(new Error('Mermaid did not initialize'))
    }
    script.onerror = () => reject(new Error('Failed to load Mermaid'))
    document.head.appendChild(script)
  })
}

async function loadMermaid(config: Record<string, unknown>): Promise<MermaidModule> {
  mermaidPromise ??= loadMermaidScript().catch((err: unknown) => {
    // Reset so a transient network failure doesn't disable mermaid for good.
    mermaidPromise = null
    throw err
  })
  const m = await mermaidPromise
  m.initialize(config)
  return m
}

/**
 * Mermaid measures label widths with the configured font while it lays a
 * diagram out. Load the body font first (bounded), or the boxes are sized
 * for a fallback font and the inlined labels overflow them.
 */
async function loadMermaidFont(config: Record<string, unknown>, timeoutMs = 2000): Promise<void> {
  const family = typeof config.fontFamily === 'string' ? config.fontFamily : ''
  if (!family || typeof document === 'undefined' || !document.fonts) return
  const loads = ['400', '600'].map(w => document.fonts.load(`${w} 12px ${family}`).catch(() => []))
  await Promise.race([Promise.all(loads), new Promise(r => setTimeout(r, timeoutMs))])
}

/** Replace every `pre > code.language-mermaid` block in `html` with its rendered diagram. */
export async function transformMermaid(html: string, opts: MermaidRenderOptions): Promise<string> {
  if (!html.includes('language-mermaid')) return html
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html')
  const blocks = Array.from(doc.querySelectorAll('pre code.language-mermaid'))
  if (blocks.length === 0) return html
  await loadMermaidFont(opts.config)
  const m = await loadMermaid(opts.config)
  for (const code of blocks) {
    const pre = code.parentElement
    if (!pre) continue
    await replaceMermaidBlock(doc, pre, code.textContent || '', m, opts.locale)
  }
  return doc.body.innerHTML
}

function renderId(): string {
  // crypto.randomUUID() needs a secure context, and the render page is
  // served to the renderer's Chromium over plain HTTP (container to
  // container). getRandomValues works there. The id only needs to be
  // unique within this pass.
  return 'mmd-' + (globalThis.crypto.randomUUID?.()
    ?? (Date.now().toString(36) + Array.from(
      globalThis.crypto.getRandomValues(new Uint32Array(2)),
      n => n.toString(36)
    ).join('')))
}

/**
 * Render one mermaid source string and swap the originating `<pre>` for
 * either an `<img>` wrapper (success) or an error placeholder.
 */
async function replaceMermaidBlock(doc: Document, pre: Element, source: string, m: MermaidModule, locale: string): Promise<void> {
  try {
    const { svg: rawSvg } = await m.render(renderId(), source)
    const finished = finishMermaidSvg(rawSvg, locale)
    pre.replaceWith(buildMermaidImg(doc, finished))
  } catch (err: unknown) {
    const errEl = doc.createElement('div')
    errEl.className = 'mermaid-error'
    errEl.textContent = `Mermaid error: ${err instanceof Error ? err.message : 'invalid diagram'}`
    pre.replaceWith(errEl)
  }
}

/**
 * Re-serialise mermaid's SVG as well-formed XML. Mermaid 11 builds labels
 * inside `<foreignObject>` with the HTML serializer, so a label line break
 * comes out as `<br>` (no self-close); as a `data:image/svg+xml` `<img>`
 * the browser parses it as XML and the diagram renders as a broken image.
 * Parsing as HTML and serialising the `<svg>` with `XMLSerializer` closes
 * every void element. The same transform lives in
 * `pagedPreviewIframe.html` (live preview + browser print).
 */
export function toWellFormedSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'text/html')
  const el = doc.querySelector('svg')
  return el ? new XMLSerializer().serializeToString(el) : svg
}

/** Pie legend entry with `showData`: `Label [1234.5]`. */
const PIE_LEGEND_VALUE_RE = /^(.*) \[(-?\d+(?:\.\d+)?)\]$/

/**
 * Format the raw `[3320]` values Mermaid appends to pie legend entries
 * (`showData`) as `3,320` / `3.320` / `3 320` for the document language.
 */
export function formatPieLegendLabel(text: string, locale: string): string {
  const m = PIE_LEGEND_VALUE_RE.exec(text)
  if (!m?.[1] || m[2] === undefined) return text
  let fmt: Intl.NumberFormat
  try {
    fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  } catch {
    fmt = new Intl.NumberFormat('en', { maximumFractionDigits: 2 })
  }
  return `${m[1]}  ${fmt.format(Number(m[2]))}`
}

/** A bare number as Mermaid writes axis ticks: `7000`, `-250`, `0.5`. */
const BARE_NUMBER_RE = /^-?\d+(?:\.\d+)?$/

/**
 * Axis tick labels of xy-charts in the document's number format
 * (`7000` → `7,000` / `7.000`). Only numbers of 1000 and above change;
 * small numbers read the same in every locale.
 */
export function formatAxisNumber(text: string, locale: string): string {
  const t = text.trim()
  if (!BARE_NUMBER_RE.test(t) || Math.abs(Number(t)) < 1000) return text
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(Number(t))
  } catch {
    return text
  }
}

/** Most tick labels a value axis keeps (Mermaid asks d3 for ~10, e.g. 15 for 0–7000). */
const MAX_AXIS_TICKS = 8

/** `step` is 1, 2, 2.5 or 5 × 10^n. */
function isNiceStep(step: number): boolean {
  if (!Number.isFinite(step) || step <= 0) return false
  const mantissa = step / 10 ** Math.floor(Math.log10(step))
  return [1, 2, 2.5, 5, 10].some(m => Math.abs(mantissa - m) < 1e-9)
}

/**
 * Thin a crowded numeric axis (xy-chart value axis) to at most
 * `MAX_AXIS_TICKS` labels on a nice step: 0, 500, …, 7000 → 0, 1000, …,
 * 7000. Mermaid has no tick-count option. Removes the other labels and
 * their tick marks (`g.label text` and `g.ticks path` are in the same
 * order); category axes (non-numeric labels) are left alone.
 */
export function thinAxisTicks(axis: Element): void {
  const labels = Array.from(axis.querySelectorAll(':scope > g.label > text'))
  if (labels.length <= MAX_AXIS_TICKS) return
  const values = labels.map(t => (t.textContent ?? '').trim())
  if (!values.every(v => BARE_NUMBER_RE.test(v))) return
  const nums = values.map(Number)
  const step = Math.abs((nums[1] ?? 0) - (nums[0] ?? 0))
  if (Number.isNaN(step) || step <= 0) return
  const factor = [2, 4, 5, 10, 20, 25, 50].find((f) => {
    if (!isNiceStep(step * f)) return false
    return nums.filter(n => Math.abs(n / (step * f) - Math.round(n / (step * f))) < 1e-6).length <= MAX_AXIS_TICKS
  })
  if (!factor) return
  const keepStep = step * factor
  const ticks = Array.from(axis.querySelectorAll(':scope > g.ticks > path'))
  nums.forEach((n, i) => {
    if (Math.abs(n / keepStep - Math.round(n / keepStep)) < 1e-6) return
    labels[i]?.remove()
    if (ticks.length === labels.length) ticks[i]?.remove()
  })
}

/**
 * Finish a freshly rendered SVG for the page: well-formed XML (see
 * `toWellFormedSvg`), explicit pixel `width`/`height` from the viewBox
 * (diagrams that still use `useMaxWidth` come out `width="100%"`, which
 * gives an `<img>` no intrinsic size), and locale-formatted pie legend
 * values + xy-chart axis ticks. Returns the natural size for the `<img>` attributes.
 */
/** The SVG's natural size from its viewBox (null when it has none). */
function viewBoxSize(el: Element): { width: number | null, height: number | null } {
  const vb = (el.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const side = (v: number | undefined): number | null => vb.length === 4 && Number.isFinite(v) && (v ?? 0) > 0 ? Math.ceil(v ?? 0) : null
  return { width: side(vb[2]), height: side(vb[3]) }
}

function formatTexts(texts: Element[], format: (text: string) => string): void {
  for (const text of texts) {
    const t = text.textContent ?? ''
    const formatted = format(t)
    if (formatted !== t) text.textContent = formatted
  }
}

export function finishMermaidSvg(rawSvg: string, locale: string): { svg: string, width: number | null, height: number | null, kind: string } {
  const doc = new DOMParser().parseFromString(rawSvg, 'text/html')
  const el = doc.querySelector('svg')
  if (!el) return { svg: rawSvg, width: null, height: null, kind: '' }
  const kind = diagramKind(el)
  const { width, height } = viewBoxSize(el)
  if (width && height) {
    el.setAttribute('width', String(width))
    el.setAttribute('height', String(height))
    el.style.removeProperty('max-width')
    if (!el.getAttribute('style')?.trim()) el.removeAttribute('style')
  }
  formatTexts(Array.from(el.querySelectorAll('g.legend text')), t => formatPieLegendLabel(t, locale))
  for (const axis of Array.from(el.querySelectorAll('g.left-axis, g.bottom-axis, g.right-axis, g.top-axis'))) {
    thinAxisTicks(axis)
  }
  formatTexts(Array.from(el.querySelectorAll('g.left-axis text, g.bottom-axis text, g.right-axis text, g.top-axis text')), t => formatAxisNumber(t, locale))
  return { svg: new XMLSerializer().serializeToString(el), width, height, kind }
}

/**
 * Diagram type from mermaid's `aria-roledescription` (`pie`, `xychart`,
 * `flowchart-v2` …), reduced to a class-safe token. The wrapper gets
 * `mermaid-<kind>` so themeToCss can size diagram types differently.
 */
export function diagramKind(svg: Element): string {
  return (svg.getAttribute('aria-roledescription') ?? '').toLowerCase().replaceAll(/[^a-z0-9-]/g, '').slice(0, 32)
}

/** UTF-8 → base64 in 32 KiB chunks (no deprecated `unescape`, no stack blow-up). */
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function base64ToUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = Uint8Array.from(binary, ch => ch.codePointAt(0) ?? 0)
  return new TextDecoder().decode(bytes)
}

function buildMermaidImg(doc: Document, finished: { svg: string, width: number | null, height: number | null, kind: string }): HTMLElement {
  const wrap = doc.createElement('div')
  wrap.className = finished.kind ? `mermaid mermaid-${finished.kind}` : 'mermaid'
  const img = doc.createElement('img')
  img.src = `${SVG_DATA_PREFIX}${utf8ToBase64(finished.svg)}`
  img.alt = ''
  if (finished.width) img.setAttribute('width', String(finished.width))
  if (finished.height) img.setAttribute('height', String(finished.height))
  wrap.appendChild(img)
  return wrap
}

const SVG_DATA_PREFIX = 'data:image/svg+xml;base64,'

let svgPurifier: ReturnType<typeof createDOMPurify> | null = null

/**
 * Sanitise a mermaid SVG for inlining into the render page (which runs in
 * the app's origin): DOMPurify's SVG profile, no script, no event
 * handlers, no `<foreignObject>` / `<use>`, no external references. A
 * diagram that needed `<foreignObject>` would lose its labels, so those
 * stay images (see `inlineMermaidSvgs`).
 */
export function sanitizeMermaidSvg(svg: string): SVGSVGElement | null {
  svgPurifier ??= createDOMPurify(globalThis.window)
  const fragment = svgPurifier.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // Mermaid scopes its <style> to the diagram id and references markers
    // via url(#id) inside the same SVG.
    ADD_TAGS: ['style'],
    ADD_ATTR: ['dominant-baseline', 'marker-end', 'marker-start'],
    RETURN_DOM_FRAGMENT: true
  })
  const el = fragment.firstElementChild
  return el instanceof SVGSVGElement ? el : null
}

/**
 * After pagination: replace each mermaid `<img>` under `root` with its
 * sanitised, inlined SVG so chart text uses the page's web fonts. The SVG
 * takes the image's place with the same intrinsic size and CSS (see
 * themeToCss `.mermaid img, .mermaid svg`), so nothing reflows. Diagrams
 * that use `<foreignObject>` stay images.
 */
export function inlineMermaidSvgs(root: ParentNode): number {
  let count = 0
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('.mermaid > img'))) {
    const src = img.getAttribute('src') ?? ''
    if (!src.startsWith(SVG_DATA_PREFIX)) continue
    let svgText: string
    try {
      svgText = base64ToUtf8(src.slice(SVG_DATA_PREFIX.length))
    } catch {
      continue
    }
    if (/<foreignObject/i.test(svgText)) continue
    const svg = sanitizeMermaidSvg(svgText)
    if (!svg) continue
    const width = img.getAttribute('width')
    const height = img.getAttribute('height')
    if (width) svg.setAttribute('width', width)
    if (height) svg.setAttribute('height', height)
    svg.setAttribute('role', 'img')
    img.replaceWith(img.ownerDocument.importNode(svg, true))
    count++
  }
  return count
}
