<script setup lang="ts">
import { renderMarkdown } from '~/utils/markdown/renderMarkdown'
import { composeFinalHtml } from '~/utils/preview/composeFinalHtml'
import { themeToCss, themeFontsImport } from '~~/shared/utils/theme/themeToCss'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import type { DocTheme } from '~~/shared/types/theme'
import { PAGEDJS_POLYFILL_URL, PAGEDJS_POLYFILL_SRI } from '~~/shared/utils/vendor/pagedjsAssets'
import { hljsTheme } from '~~/shared/utils/vendor/hljsAssets'
import { KATEX_CSS_URL, KATEX_CSS_SRI } from '~~/shared/utils/vendor/katexAssets'
import { transformMermaid, inlineMermaidSvgs } from '~/utils/markdown/mermaidLoader'
import { buildMermaidConfig } from '~~/shared/utils/markdown/mermaidConfig'
import { isPagedRuntime, registerPagedHandlers } from '~/utils/preview/pagedHandlers'
import { documentTexts } from '~~/shared/utils/documents/documentLocale'
import { sanitizeCustomCssForRender } from '~/utils/preview/customCssLoader'
import { themeImagesForDoc } from '~~/shared/utils/theme/themeImages'
import { attachRenderFileTokens, renderBrandFileUrl, withRenderFileToken, type RenderFileAccess } from '~/utils/preview/renderFileTokens'
import { brandFontFaceCss } from '~~/shared/utils/theme/brandFonts'
import { citationStyleOf } from '~~/shared/utils/citations/citationStyles'

// Cheap structural sanity check, the bootstrap endpoint already returns
// a DB-validated theme, so we just need a guard against truly broken
// shapes (e.g. {}). We deliberately DON'T import looksLikeTheme from
// shared/utils/theme/themeValidation because it transitively pulls zod through
// shared/types/theme.ts, and Vite's SSR transform on this page wedges
// on the zod import (the dev SSR resolver doesn't see `z` as a value
// for some reason: `'undefined is not an object (evaluating
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
// Server-replayed Y.Doc: the bootstrap endpoint reads the latest yjs_updates
// rows, replays them, and returns the materialized markdown directly. No
// Hocuspocus connection from this page, one fewer moving part, ~1-2s saved
// per render, and integration tests can run without a sync container.

definePageMeta({
  layout: false
})

const route = useRoute()
const docId = route.params.docId as string
const t = route.query.t as string | undefined

const { data: bootstrap, error: bootstrapError } = await useFetch('/api/_internal/render-bootstrap', {
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
  // Full schema validation runs here, client-side only (the zod import is
  // what wedges SSR, see above): the stored theme is validated at write
  // time, but render time must not depend on that. Invalid → default
  // theme; image URLs that don't belong to this document are dropped.
  const { isValidTheme } = await import('~~/shared/utils/theme/themeValidation')
  const stored = bootstrap.value?.theme
  const validTheme: DocTheme = themeImagesForDoc(
    looksLikeTheme(stored) && isValidTheme(stored) ? stored : defaultTheme,
    docId
  ).theme
  // Web snapshot for a published page: the same pipeline, but no
  // cover page and no pagination, the page shows the title itself.
  const webMode = route.query.mode === 'web'
  const theme: DocTheme = webMode ? { ...validTheme, cover: { ...validTheme.cover, enabled: false } } : validTheme
  const title = bootstrap.value?.title ?? ''
  const markdown = bootstrap.value?.markdown ?? ''
  // Cover date, `{date}` token, TOC title and chart number formats follow
  // the document language (same helper as the live preview).
  const texts = documentTexts(theme, bootstrap.value?.language)
  // File-access token (5-min, doc-scoped, read-only JWT from the
  // bootstrap) so private / password-gated / workspace-only docs' images
  // load: the renderer's Chromium has no session cookie. It goes ONLY to
  // exact `/api/files/<docId>/<fileId>` URLs of this document's confirmed
  // uploads and to the workspace's brand-kit files: `<img src>` in
  // the body + cover logo, the header/footer images (themeToCss
  // `imageUrl`), own-upload url()s in custom CSS and the brand fonts.
  // Nothing in the content can make the page attach it to another URL.
  const fileAccess: RenderFileAccess = {
    docId,
    fileIds: new Set(bootstrap.value?.fileIds ?? []),
    token: bootstrap.value?.fileAccessToken ?? '',
    brandFiles: new Set(bootstrap.value?.brandFiles ?? [])
  }
  const fontsImport = [
    themeFontsImport(theme),
    brandFontFaceCss(bootstrap.value?.brandFonts, file => renderBrandFileUrl(file, fileAccess) ?? '')
  ].filter(Boolean).join('\n')

  // Fonts first: Mermaid measures label widths with the body font, and
  // paged.js measures every line. Bounded at 3s so a slow font load
  // doesn't wedge the whole render, paged.js will use whatever's loaded.
  const fontsEl = document.createElement('style')
  fontsEl.textContent = fontsImport
  document.head.appendChild(fontsEl)
  await Promise.race([
    document.fonts.ready,
    new Promise(r => setTimeout(r, 3000))
  ])

  const rawHtml = await renderMarkdown(markdown)
  const bodyHtml = await transformMermaid(rawHtml, { config: buildMermaidConfig(theme), locale: texts.locale })
  // Cover + drop-cap composition through the shared helper so the
  // server PDF matches the live preview byte-for-byte.
  let html = composeFinalHtml({
    theme,
    title,
    date: texts.date,
    bodyHtml,
    language: bootstrap.value?.language ?? '',
    // Validated server-side from Y.js (render-bootstrap, readDocCitations).
    citations: {
      items: bootstrap.value?.bibliography ?? [],
      style: citationStyleOf(bootstrap.value?.citationStyle)
    }
  })
  html = attachRenderFileTokens(html, fileAccess)

  // Custom CSS: sanitized again here (the stored theme may have arrived
  // via a direct Y.js write). The sanitizer keeps only exact own-upload
  // url()s (normalised to `/api/files/<docId>/<fileId>`), which get the
  // same file-access token; everything else external is already gone,
  // and the CSP + renderer allowlist back that up.
  const customCss = await sanitizeCustomCssForRender(
    typeof theme.customCss === 'string' ? theme.customCss : undefined,
    {
      docId,
      allowedOrigins: bootstrap.value?.appOrigins ?? [],
      fileUrl: path => withRenderFileToken(path, fileAccess)
    }
  )
  const themeCss = themeToCss(theme, {
    title,
    date: texts.date,
    tocTitle: texts.tocTitle,
    captionLabels: texts.captionLabels,
    customCss,
    imageUrl: url => withRenderFileToken(url, fileAccess)
  })

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

  // Web snapshot (publish): hand the composed, sanitised HTML + the
  // theme CSS back to the renderer instead of paginating. Mermaid
  // diagrams are inlined as sanitised SVG like after pagination; the
  // file-access token is taken off every URL, the app rewrites them to
  // the published page's own file routes.
  if (webMode) {
    const container = document.createElement('div')
    container.innerHTML = html
    inlineMermaidSvgs(container)
    const stripTokens = (text: string) => text.replace(/\?token=[^"'()\s&<>]*/g, '')
    const hljsWeb = hljsTheme(theme.code.theme)
    ;(globalThis as unknown as { __webSnapshot?: unknown }).__webSnapshot = {
      html: stripTokens(container.innerHTML),
      css: stripTokens(themeCss),
      fontsImport: stripTokens(fontsImport),
      hljsTheme: theme.code.theme,
      hljsUrl: hljsWeb.url ?? null,
      language: texts.locale
    }
    ;(globalThis as unknown as { __webReady?: boolean }).__webReady = true
    return
  }

  // Mount target. paged.js writes the paginated DOM into this container.
  const placeholder = document.getElementById('render-mount')
  placeholder?.remove()
  const mount = document.createElement('div')
  mount.id = 'paged-mount'
  document.body.appendChild(mount)

  // Reset for clean PDF output, strip everything else from the body
  // surface around our mount, and override Nuxt's chrome.
  document.body.style.margin = '0'
  document.body.style.padding = '0'
  document.body.style.background = 'white'

  // KaTeX + hljs CSS, these are needed for visual correctness but they
  // CAN sit in the head; we just don't pass them to paged.js. paged.js
  // reads them naturally as a regular browser stylesheet during render.
  const hljs = hljsTheme(theme.code.theme)
  if (hljs.url) {
    // SRI-locked like every vendored asset (shared/utils/vendor/hljsAssets.ts).
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.integrity = hljs.sri
    link.crossOrigin = 'anonymous'
    link.href = hljs.url
    document.head.appendChild(link)
  }
  // KaTeX is SRI-locked: same rationale as the live preview iframe.
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
  // pagedPreviewIframe.html: copying its decode pattern here so the
  // server-rendered output isn't visually inconsistent with the live
  // preview.
  //
  // We work against an off-screen scratch container instead of the
  // mount target: paged.js needs the mount empty to write its paginated
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
  // Same for images referenced from custom CSS (backgrounds etc.):
  // nothing in the DOM waits for a CSS image, so warm them up here and
  // again after pagination.
  await preloadImages(customCss?.urls ?? [])

  // PagedConfig must be set BEFORE the polyfill loads. auto:false stops
  // the polyfill from auto-scanning the document, we drive the render
  // manually below via Previewer.preview().
  ;(globalThis as unknown as { PagedConfig: { auto: boolean } }).PagedConfig = { auto: false }

  // Load the polyfill, then drive the render explicitly with our theme
  // CSS as a named stylesheet, paged.js's Polisher only processes
  // @page rules from this argument, so it never sees Nuxt's oklch().
  await new Promise<void>((resolve, reject) => {
    const polyfill = document.createElement('script')
    polyfill.src = PAGEDJS_POLYFILL_URL
    // SRI-locked + crossorigin="anonymous" (same-origin /vendor/ file,
    // the hash pins its exact bytes, shared/utils/vendor/pagedjsAssets.ts).
    polyfill.integrity = PAGEDJS_POLYFILL_SRI
    polyfill.crossOrigin = 'anonymous'
    polyfill.onload = () => resolve()
    polyfill.onerror = () => reject(new Error('Failed to load paged.js polyfill'))
    document.head.appendChild(polyfill)
  })

  const Paged: unknown = Reflect.get(globalThis, 'Paged')
  if (!isPagedRuntime(Paged)) throw new Error('paged.js did not initialise')
  // Keep-with-next headings, whole-block moves, row-safe table breaks with
  // repeated headers, orphan control, same handlers as the live preview.
  registerPagedHandlers(Paged)
  const previewer = new Paged.Previewer()
  const result = await previewer.preview(
    `<div class="paged-doc">${html}</div>`,
    [{ 'theme.css': themeCss }],
    mount
  )

  // Wait for images IN THE PAGINATED DOM to decode. paged.js CLONES the
  // source HTML into new <img> nodes inside `.pagedjs_page` containers
  // during pagination: those clones need to load independently of the
  // pre-pagination decode pass we did into the scratch container. The
  // image bytes are usually browser-cached at this point so this resolves
  // fast, but on a cold cache (or a slow renderer container start)
  // page.pdf() will fire before pixels exist and the PDF comes up with
  // missing images. element.screenshot() waits for in-viewport images,
  // but page.pdf() does not, so images show up on direct
  // screenshots but are absent from the produced PDF without this wait.
  // Mermaid diagrams were atomic <img>s for pagination; now inline them
  // (sanitised) so their text uses the document's web fonts.
  inlineMermaidSvgs(mount)
  const paginatedImgs = Array.from(mount.querySelectorAll('img'))
  if (paginatedImgs.length > 0) {
    await Promise.all(paginatedImgs.map(img => img.decode().catch(() => undefined)))
  }
  await preloadImages(customCss?.urls ?? [])

  window.__pagedPageCount = result?.total ?? document.querySelectorAll('.pagedjs_page').length
  window.__pagedReady = true
})

/** Fetch + decode each URL as an image; failures are ignored (a broken
 *  background must not fail the whole render). */
async function preloadImages(urls: readonly string[]): Promise<void> {
  if (urls.length === 0) return
  await Promise.all(urls.map((src) => {
    const img = new Image()
    img.src = src
    return img.decode().catch(() => undefined)
  }))
}
</script>

<template>
  <div id="render-mount">
    <!-- Stripped on mount; paged.js takes over the body. -->
  </div>
</template>
