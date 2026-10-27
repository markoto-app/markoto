import type { MermaidTheme } from '~~/shared/types/theme'
import { MERMAID_URL, MERMAID_SRI } from '~~/shared/utils/mermaidCdn'

/**
 * Mermaid → `<img data:svg>` transform for a document that renders in its
 * own top-level context: the server render page
 * (`app/pages/_internal/render/[docId].vue`, loaded by the renderer
 * sidecar's Chromium). The live preview and the browser print path render
 * mermaid INSIDE their sandboxed iframe instead (pagedPreviewIframe.html),
 * so diagram source never runs through mermaid in the app's origin.
 *
 * Mermaid is the SRI-locked single-file build injected as a classic
 * `<script integrity crossorigin>` (see shared/utils/mermaidCdn.ts) — the
 * ESM build's dynamic `import()` cannot be integrity-checked.
 */

// Only `initialize` and `render` are touched — a minimal stub keeps this
// `any`-free.
interface MermaidModule {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, source: string) => Promise<{ svg: string }>
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

async function loadMermaid(theme: MermaidTheme): Promise<MermaidModule> {
  mermaidPromise ??= loadMermaidScript().catch((err: unknown) => {
    // Reset so a transient network failure doesn't disable mermaid for good.
    mermaidPromise = null
    throw err
  })
  const m = await mermaidPromise
  m.initialize({
    startOnLoad: false,
    theme,
    // Same settings as the preview iframe — see pagedPreviewIframe.html
    // for the rationale ('antiscript' keeps mermaid's <style>; 12px font;
    // htmlLabels: false so paged.js keeps diagrams in one piece).
    securityLevel: 'antiscript',
    themeVariables: { fontSize: '12px' },
    flowchart: { htmlLabels: false, padding: 25 },
    fontFamily: 'inherit'
  })
  return m
}

/** Replace every `pre > code.language-mermaid` block in `html` with its rendered diagram. */
export async function transformMermaid(html: string, theme: MermaidTheme): Promise<string> {
  if (!html.includes('language-mermaid')) return html
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html')
  const blocks = Array.from(doc.querySelectorAll('pre code.language-mermaid'))
  if (blocks.length === 0) return html
  const m = await loadMermaid(theme)
  for (const code of blocks) {
    const pre = code.parentElement
    if (!pre) continue
    await replaceMermaidBlock(doc, pre, code.textContent || '', m)
  }
  return doc.body.innerHTML
}

/**
 * Render one mermaid source string and swap the originating `<pre>` for
 * either an `<img>` wrapper (success) or an error placeholder. An `<img>`
 * is atomic for paged.js; inline SVGs get fragmented across page breaks.
 */
async function replaceMermaidBlock(doc: Document, pre: Element, source: string, m: MermaidModule): Promise<void> {
  // crypto.randomUUID() is secure-context-only. The render page is served
  // to the renderer's Chromium over plain HTTP (container to container),
  // which is NOT a secure context — fall back to getRandomValues, which
  // is defined there. The id only needs to be unique within this pass.
  const id = 'mmd-' + (globalThis.crypto.randomUUID?.()
    ?? (Date.now().toString(36) + Array.from(
      globalThis.crypto.getRandomValues(new Uint32Array(2)),
      n => n.toString(36)
    ).join('')))
  try {
    const { svg } = await m.render(id, source)
    const { natW, natH } = extractMermaidNaturalSize(svg)
    const finalSvg = natH ? svg.replace(/<svg(\b)/, `<svg height="${natH}"$1`) : svg
    pre.replaceWith(buildMermaidImg(doc, finalSvg, natW, natH))
  } catch (err: unknown) {
    const errEl = doc.createElement('div')
    errEl.className = 'mermaid-error'
    errEl.textContent = `Mermaid error: ${err instanceof Error ? err.message : 'invalid diagram'}`
    pre.replaceWith(errEl)
  }
}

/** Natural width + height from the SVG's `viewBox` (`minX minY width height`). */
function extractMermaidNaturalSize(svg: string): { natW: number | null, natH: number | null } {
  const vbNums = (/viewBox="[^"]*"/.exec(svg) ?? [''])[0].match(/[\d.]+/g)
  return {
    natW: vbNums?.[2] ? Math.round(Number.parseFloat(vbNums[2])) : null,
    natH: vbNums?.[3] ? Math.round(Number.parseFloat(vbNums[3])) : null
  }
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

function buildMermaidImg(doc: Document, svg: string, natW: number | null, natH: number | null): HTMLElement {
  const wrap = doc.createElement('div')
  wrap.className = 'mermaid'
  const img = doc.createElement('img')
  img.src = `data:image/svg+xml;base64,${utf8ToBase64(svg)}`
  img.style.cssText = 'max-width:100%;display:block;'
  if (natW) img.setAttribute('width', String(natW))
  if (natH) img.setAttribute('height', String(natH))
  wrap.appendChild(img)
  return wrap
}
