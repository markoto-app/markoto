import { KATEX_CSS_SRI, KATEX_CSS_URL } from '~~/shared/utils/vendor/katexAssets'
import { HLJS_THEMES, HLJS_STYLES_BASE } from '~~/shared/utils/vendor/hljsAssets'

// The HTML of a published page (WP13). The body is the stored snapshot:
// markdown rendered and DOMPurify-sanitised by the print page, stripped
// again of active elements before it was stored (`sanitizeSnapshot.ts`),
// theme CSS
// from `themeToCss` with the sanitised custom CSS. The page itself runs
// no script at all (`publishedPageCsp`), so even a sanitiser bypass in the
// stored HTML can't execute.

export interface PublishedPageView {
  title: string
  language: string
  html: string
  css: string
  fontsImport: string
  hljsUrl: string | null
  indexable: boolean
  /** Absolute canonical URL (indexable pages only), or null. */
  canonicalUrl: string | null
  /** Absolute URL of the abuse-report form for this page, or null. */
  reportUrl: string | null
}

const FOOTER_TEXT: Record<string, { by: string, report: string }> = {
  en: { by: 'Published with markoto', report: 'Report' },
  de: { by: 'Veröffentlicht mit markoto', report: 'Melden' },
  fr: { by: 'Publié avec markoto', report: 'Signaler' },
  es: { by: 'Publicado con markoto', report: 'Denunciar' },
  ja: { by: 'markoto で公開', report: '報告' },
  zh: { by: '使用 markoto 发布', report: '举报' }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** CSS placed inside <style>: it must not be able to close the element. */
export function cssForStyleElement(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
}

/** Only our vendored highlight.js theme stylesheets, with their SRI (the stored value is checked again here). */
export function publishedHljsStylesheet(url: string | null): { url: string, sri: string } | null {
  if (!url) return null
  const entry = Object.values(HLJS_THEMES).find(t => url === `${HLJS_STYLES_BASE}${t.path}.min.css`)
  return entry ? { url, sri: entry.sri } : null
}

function langTag(language: string): string {
  return /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(language) ? language : 'en'
}

/** Screen layout for the snapshot: one readable column, theme colours, no paged.js. */
const WEB_CSS = `
body { margin: 0; }
.mk-published { box-sizing: border-box; max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 2rem; }
.mk-published .paged-doc { column-count: 1 !important; }
.mk-published img, .mk-published svg, .mk-published video { max-width: 100%; height: auto; }
.mk-published pre { overflow-x: auto; }
@media (max-width: 40rem) { .mk-published table { display: block; max-width: 100%; overflow-x: auto; } }
.mk-published .markoto-pagebreak, .mk-published .pagebreak { display: none; }
.mk-published-footer { margin-top: 3rem; font: 12px/1.5 system-ui, sans-serif; color: #7a756c; display: flex; gap: .75rem; }
.mk-published-footer a { color: inherit; }
@media print { .mk-published-footer { display: none; } }
`

export function buildPublishedPageHtml(page: PublishedPageView): string {
  const lang = langTag(page.language)
  const text = FOOTER_TEXT[lang.slice(0, 2).toLowerCase()] ?? FOOTER_TEXT.en!
  const hljs = publishedHljsStylesheet(page.hljsUrl)
  // The theme's paper colour for the whole page, not just the text column.
  const bg = /--doc-bg:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(page.css)?.[1] ?? '#ffffff'
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(page.title || 'Untitled')}</title>`,
    `<meta name="robots" content="${page.indexable ? 'index, follow' : 'noindex, nofollow'}">`,
    '<meta name="referrer" content="strict-origin-when-cross-origin">',
    page.indexable && page.canonicalUrl ? `<link rel="canonical" href="${escapeHtml(page.canonicalUrl)}">` : '',
    `<link rel="stylesheet" href="${KATEX_CSS_URL}" integrity="${KATEX_CSS_SRI}" crossorigin="anonymous">`,
    hljs ? `<link rel="stylesheet" href="${escapeHtml(hljs.url)}" integrity="${hljs.sri}" crossorigin="anonymous">` : '',
    page.fontsImport ? `<style>${cssForStyleElement(page.fontsImport)}</style>` : '',
    `<style>${cssForStyleElement(page.css)}\n${WEB_CSS}\nhtml { background: ${bg}; }</style>`
  ].filter(Boolean).join('\n')
  const report = page.reportUrl
    ? ` <span aria-hidden="true">·</span> <a href="${escapeHtml(page.reportUrl)}" rel="nofollow">${text.report}</a>`
    : ''
  return `<!doctype html>
<html lang="${lang}">
<head>
${head}
</head>
<body>
<main class="mk-published"><div class="paged-doc">${page.html}</div>
<footer class="mk-published-footer"><span>${text.by}</span>${report}</footer></main>
</body>
</html>
`
}

/**
 * CSP of a published page: no script of any kind, resources only from
 * this host (vendored fonts / KaTeX / highlight.js, the page's copied
 * files), no forms, no framing. `sandbox` (with same-origin, so the
 * page's own font / image requests stay same-origin) adds a second lock
 * on scripts and forms.
 */
export function publishedPageCsp(): string {
  return [
    `default-src 'none'`,
    `img-src 'self' data:`,
    `style-src 'self' 'unsafe-inline'`,
    `font-src 'self' data:`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `frame-ancestors 'none'`,
    `sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation`
  ].join('; ')
}
