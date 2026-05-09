<script setup lang="ts">
import { renderMarkdown } from '~/utils/renderMarkdown'
import { composeFinalHtml } from '~~/shared/utils/composeFinalHtml'
import { themeToCss, themeFontsImport } from '~~/shared/utils/themeToCss'
import { defaultTheme } from '~~/shared/utils/defaultTheme'
import type { DocTheme, MermaidTheme } from '~~/shared/types/theme'
import { PAGEDJS_POLYFILL_URL, PAGEDJS_POLYFILL_SRI } from '~~/shared/utils/pagedjsCdn'
import { hljsThemeUrl } from '~~/shared/utils/hljsCdn'
import { KATEX_CSS_URL, KATEX_CSS_SRI } from '~~/shared/utils/katexCdn'
import { MERMAID_ESM_URL } from '~~/shared/utils/mermaidCdn'

// Cheap structural sanity check — the bootstrap endpoint already returns
// a DB-validated theme, so we just need a guard against truly broken
// shapes (e.g. {}). We deliberately DON'T import looksLikeTheme from
// shared/utils/themeValidation because it transitively pulls zod through
// shared/types/theme.ts, and Vite's SSR transform on this page wedges
// on the zod import (the dev SSR resolver doesn't see `z` as a value
// for some reason — `'undefined is not an object (evaluating
// __vite_ssr_import_0__.z.string)'`). The full editor pages don't hit
// this because they import zod-using code lazily; this print page
// loads it eagerly during SSR.
function looksLikeTheme(t: unknown): t is DocTheme {
  if (!t || typeof t !== 'object') return false
  const x = t as Record<string, unknown>
  return typeof x.body === 'object'
    && typeof x.headings === 'object'
    && typeof x.code === 'object'
    && typeof x.mermaid === 'object'
}

// Internal print page used by the Playwright renderer container. Mounted
// at /_internal/render/:docId?t=<jwt>. The renderer:
//   1. Mints a render-token JWT signed with INTERNAL_API_SECRET (60s TTL).
//   2. Navigates Chromium to this page with ?t=<jwt>.
//   3. Waits for window.__pagedReady === true.
//   4. Calls page.pdf() and page.locator('.pagedjs_page').screenshot().
//
// Server-replayed Y.Doc: the bootstrap endpoint reads the latest yjs_documents
// rows, replays them, and returns the materialized markdown directly. No
// Hocuspocus connection from this page — one fewer moving part, ~1-2s saved
// per render, and integration tests can run without a sync container.

definePageMeta({
  layout: false
})

const route = useRoute()
const docId = route.params.docId as string
const t = route.query.t as string | undefined

const { data: bootstrap, error: bootstrapError } = await useFetch<{
  snapshotId: number
  markdown: string
  theme: DocTheme | null
  title: string
  description: string
  audience: string
  language: string
  fileAccessToken: string
}>('/api/_internal/render-bootstrap', {
  query: { docId, t },
  key: `render-bootstrap-${docId}-${t ?? ''}`,
  retry: false
})

if (bootstrapError.value || !bootstrap.value) {
  throw createError({
    statusCode: 403,
    statusMessage: 'Render token invalid or expired'
  })
}

onMounted(async () => {
  const theme: DocTheme = (bootstrap.value && looksLikeTheme(bootstrap.value.theme))
    ? bootstrap.value.theme!
    : defaultTheme
  const title = bootstrap.value?.title ?? ''
  const markdown = bootstrap.value?.markdown ?? ''

  const rawHtml = await renderMarkdown(markdown)
  const bodyHtml = await transformMermaid(rawHtml, theme.mermaid.theme)
  // Cover + drop-cap composition through the shared helper so the
  // server PDF matches the live preview byte-for-byte.
  let html = composeFinalHtml({
    theme,
    title,
    dateIso: new Date().toISOString().slice(0, 10),
    bodyHtml
  })
  // Append the file-access token to every /api/files/{docId}/... URL so
  // private / password-gated / workspace-only docs' images load. The
  // renderer's Chromium has no session cookie; without this every
  // image 403s and the PDF comes up with broken images. The token is
  // a 5-min, doc-scoped, read-only JWT minted by the bootstrap.
  const t = bootstrap.value!.fileAccessToken
  const fileUrlRe = new RegExp(`/api/files/${docId}/([^"' )?]+)`, 'g')
  html = html.replace(fileUrlRe, (_, fileId) => `/api/files/${docId}/${fileId}?token=${encodeURIComponent(t)}`)

  const themeCss = themeToCss(theme, {
    title,
    date: new Date().toISOString().slice(0, 10),
    tocTitle: 'Table of Contents'
  })
  const fontsImport = themeFontsImport(theme)

  document.title = title || 'Render'

  // CRITICAL: paged.js 0.4.3's CSS atrule parser does NOT understand
  // modern color functions like oklch() or color-mix(). Nuxt UI injects
  // <style id="nuxt-ui-colors"> with hundreds of oklch(...) values into
  // the head during SSR; if paged.js's polisher sees them in `auto: true`
  // mode (where it scans the document for stylesheets) it crashes deep
  // in atrule parsing with "Cannot read properties of undefined". We
  // therefore use the EXPLICIT API: Previewer.preview(html, [{ name:
  // cssText }], mount) bypasses document scanning entirely. The Nuxt
  // UI styles can stay in the head; paged.js will never look at them.

  // Wait for fonts before paginating. Bounded at 3s so a slow CDN doesn't
  // wedge the whole render — paged.js will use whatever's loaded.
  // We DO inject the @import in head though so the font fetch happens.
  const fontsEl = document.createElement('style')
  fontsEl.textContent = fontsImport
  document.head.appendChild(fontsEl)
  await Promise.race([
    document.fonts.ready,
    new Promise(r => setTimeout(r, 3000))
  ])

  // Mount target. paged.js writes the paginated DOM into this container.
  const placeholder = document.getElementById('render-mount')
  placeholder?.remove()
  const mount = document.createElement('div')
  mount.id = 'paged-mount'
  document.body.appendChild(mount)

  // Reset for clean PDF output — strip everything else from the body
  // surface around our mount, and override Nuxt's chrome.
  document.body.style.margin = '0'
  document.body.style.padding = '0'
  document.body.style.background = 'white'

  // KaTeX + hljs CSS — these are needed for visual correctness but they
  // CAN sit in the head; we just don't pass them to paged.js. paged.js
  // reads them naturally as a regular browser stylesheet during render.
  const hljsUrl = hljsThemeUrl(theme.code.theme)
  if (hljsUrl) {
    // No SRI on hljs theme stylesheets — see shared/utils/hljsCdn.ts.
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = hljsUrl
    document.head.appendChild(link)
  }
  // KaTeX is SRI-locked — same rationale as the live preview iframe.
  const katexLink = document.createElement('link')
  katexLink.rel = 'stylesheet'
  katexLink.href = KATEX_CSS_URL
  katexLink.integrity = KATEX_CSS_SRI
  katexLink.crossOrigin = 'anonymous'
  document.head.appendChild(katexLink)

  // Decode every image BEFORE paged.js paginates. Without this paged.js
  // measures placeholder dimensions (zero or estimated), lays the
  // document out around them, and the resulting PDF / screenshot
  // captures whichever images happened to have loaded by the time
  // pagination ran. The original preview iframe does the same in
  // pagedPreviewIframe.html — copying its decode pattern here so the
  // server-rendered output isn't visually inconsistent with the live
  // preview.
  //
  // We work against an off-screen scratch container instead of the
  // mount target — paged.js needs the mount empty to write its paginated
  // DOM there. Per-image errors are swallowed so one broken image
  // (broken-href, 403, network blip) doesn't kill the whole render.
  const scratch = document.createElement('div')
  scratch.style.cssText = 'position:fixed;left:-20000px;top:0;visibility:hidden;'
  scratch.innerHTML = html
  document.body.appendChild(scratch)
  try {
    const imgs = Array.from(scratch.querySelectorAll('img'))
    if (imgs.length > 0) {
      await Promise.all(imgs.map(img => img.decode().catch(() => undefined)))
    }
  } finally {
    scratch.remove()
  }

  // PagedConfig must be set BEFORE the polyfill loads. auto:false stops
  // the polyfill from auto-scanning the document — we drive the render
  // manually below via Previewer.preview().
  ;(window as unknown as { PagedConfig: { auto: boolean } }).PagedConfig = { auto: false }

  // Load the polyfill, then drive the render explicitly with our theme
  // CSS as a named stylesheet — paged.js's Polisher only processes
  // @page rules from this argument, so it never sees Nuxt's oklch().
  await new Promise<void>((resolve, reject) => {
    const polyfill = document.createElement('script')
    polyfill.src = PAGEDJS_POLYFILL_URL
    // SRI-locked + crossorigin="anonymous" to defend against a poisoned
    // jsdelivr response in the server-render path.
    polyfill.integrity = PAGEDJS_POLYFILL_SRI
    polyfill.crossOrigin = 'anonymous'
    polyfill.onload = () => resolve()
    polyfill.onerror = () => reject(new Error('Failed to load paged.js polyfill'))
    document.head.appendChild(polyfill)
  })

  type Previewer = new () => {
    preview: (html: string, stylesheets: Array<Record<string, string>>, mount: HTMLElement)
    => Promise<{ total: number }>
  }
  const Paged = (window as unknown as { Paged: { Previewer: Previewer } }).Paged
  const previewer = new Paged.Previewer()
  const result = await previewer.preview(
    `<div class="paged-doc">${html}</div>`,
    [{ 'theme.css': themeCss }],
    mount
  )

  // Wait for images IN THE PAGINATED DOM to decode. paged.js CLONES the
  // source HTML into new <img> nodes inside `.pagedjs_page` containers
  // during pagination — those clones need to load independently of the
  // pre-pagination decode pass we did into the scratch container. The
  // image bytes are usually browser-cached at this point so this resolves
  // fast, but on a cold cache (or a slow renderer container start)
  // page.pdf() will fire before pixels exist and the PDF comes up with
  // missing images. element.screenshot() apparently waits for in-viewport
  // images, but page.pdf() does not — hence images appeared on direct
  // screenshots but were absent from the produced PDF until this wait
  // landed.
  const paginatedImgs = Array.from(mount.querySelectorAll('img'))
  if (paginatedImgs.length > 0) {
    await Promise.all(paginatedImgs.map(img => img.decode().catch(() => undefined)))
  }

  ;(window as Window & {
    __pagedReady?: boolean
    __pagedPageCount?: number
  }).__pagedPageCount = result?.total ?? document.querySelectorAll('.pagedjs_page').length
  ;(window as Window & { __pagedReady?: boolean }).__pagedReady = true
})

interface MermaidModule {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, source: string) => Promise<{ svg: string }>
}
let mermaidPromise: Promise<MermaidModule> | null = null
async function loadMermaid(theme: MermaidTheme): Promise<MermaidModule> {
  if (!mermaidPromise) {
    // Dynamic import() does not support SRI — mermaid is best-effort
    // (see shared/utils/mermaidCdn.ts).
    mermaidPromise = import(/* @vite-ignore */ MERMAID_ESM_URL)
      .then(mod => mod.default)
      .catch((err) => {
        mermaidPromise = null
        throw err
      })
  }
  const m = await mermaidPromise
  m.initialize({
    startOnLoad: false,
    theme,
    securityLevel: 'antiscript',
    themeVariables: { fontSize: '12px' },
    flowchart: { htmlLabels: false, padding: 25 },
    fontFamily: 'inherit'
  })
  return m
}

async function transformMermaid(html: string, theme: MermaidTheme): Promise<string> {
  if (html.indexOf('language-mermaid') === -1) return html
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html')
  const blocks = Array.from(doc.querySelectorAll('pre code.language-mermaid'))
  if (blocks.length === 0) return html
  const m = await loadMermaid(theme)
  for (const code of blocks) {
    const pre = code.parentElement
    if (!pre) continue
    const source = code.textContent || ''
    const id = 'mmd-' + crypto.randomUUID()
    try {
      let { svg } = await m.render(id, source)
      const vbNums = (svg.match(/viewBox="[^"]*"/) ?? [''])[0].match(/[\d.]+/g)
      const natH = vbNums?.[3] ? Math.round(Number.parseFloat(vbNums[3])) : null
      const natW = vbNums?.[2] ? Math.round(Number.parseFloat(vbNums[2])) : null
      if (natH) svg = svg.replace(/<svg(\b)/, `<svg height="${natH}"$1`)
      const wrap = doc.createElement('div')
      wrap.className = 'mermaid'
      const svgBase64 = btoa(unescape(encodeURIComponent(svg)))
      const img = doc.createElement('img')
      img.src = `data:image/svg+xml;base64,${svgBase64}`
      img.style.cssText = 'max-width:100%;display:block;'
      if (natW) img.setAttribute('width', String(natW))
      if (natH) img.setAttribute('height', String(natH))
      wrap.appendChild(img)
      pre.replaceWith(wrap)
    } catch (err: unknown) {
      const errEl = doc.createElement('div')
      errEl.className = 'mermaid-error'
      errEl.textContent = `Mermaid error: ${err instanceof Error ? err.message : 'invalid diagram'}`
      pre.replaceWith(errEl)
    }
  }
  return doc.body.innerHTML
}
</script>

<template>
  <div id="render-mount">
    <!-- Stripped on mount; paged.js takes over the body. -->
  </div>
</template>
