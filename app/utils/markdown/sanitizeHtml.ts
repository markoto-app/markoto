import createDOMPurify, { type DOMPurify, type UponSanitizeAttributeHookEvent, type UponSanitizeElementHookEvent } from 'dompurify'

/**
 * The one HTML sanitizer of the render pipeline. `renderMarkdown` runs it
 * over the markdown output and `composeFinalHtml` runs it again over the
 * composed document (cover + body + drop cap), so nothing reaches the
 * preview iframe, the print iframe or the server render page unsanitised.
 *
 * Browser-only (DOMPurify needs a window): the instance is created on the
 * first call, so importing this module during SSR is harmless.
 */

const SANITIZE_OPTS = {
  ALLOWED_TAGS: [
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'div', 'dl',
    'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'i', 'img', 'input', 'ins', 'li', 'mark', 'nav', 'ol', 'p', 'pre',
    's', 'section', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td',
    'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
    // KaTeX MathML output (@mdit/plugin-katex with output=htmlAndMathml):
    // gives screen readers + copy-paste the semantic tree.
    'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'mtext',
    'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mover', 'munder',
    'munderover', 'mspace', 'mstyle', 'mpadded', 'menclose', 'mtable',
    'mtr', 'mtd',
    // KaTeX draws stretchy symbols as inline SVG. Only inside KaTeX's
    // HTML output, only these three tags and their geometry attributes
    // (`onElement` / `onAttribute` below).
    'svg', 'path', 'line'
  ],
  ALLOWED_ATTR: [
    'href', 'src', 'alt', 'title', 'target', 'rel',
    'class',
    'id',
    'type', 'checked', 'disabled',
    // img-size emits width/height as bare attributes.
    'width', 'height',
    // KaTeX positions glyph stacks (fractions, roots, accents) with
    // inline `style`, and `{style=…}` is a documented markdown attribute.
    // DOMPurify does NOT parse CSS, so every value goes through
    // `filterInlineStyle` (property allowlist + value checks) below.
    'style',
    // MathML attributes used by KaTeX.
    'mathvariant', 'displaystyle', 'scriptlevel', 'encoding',
    // KaTeX's a11y wrapping of the HTML rendering.
    'aria-hidden', 'role',
    // KaTeX SVG geometry (only kept on the KaTeX SVG elements, see `KATEX_SVG_ATTRS`).
    'viewbox', 'preserveaspectratio', 'd', 'x1', 'y1', 'x2', 'y2', 'stroke-width'
  ],
  // Explicit URI allowlist, stricter than DOMPurify's default. Permits
  // http(s), mailto, and any URL without a scheme (absolute or relative
  // paths, `//host/…`, `#anchor`): the `[^:]*(?:\/|#|$)` branch passes a
  // string only if no `:` appears before a path separator / fragment / end.
  // Every other scheme (javascript:, vbscript:, file:, ftp:, tel:, …) is
  // denied. DOMPurify separately keeps `data:` on `<img src>`, which the
  // mermaid transform relies on; markdown-it only emits raster
  // `data:image/*` there.
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|[^:]*(?:\/|#|$))/i
}

/**
 * Inline-style properties that may survive. KaTeX's own set (it sets
 * these through `element.style`) plus plain layout/typography for the
 * documented `{style=…}` attribute. Deliberately absent: anything that
 * takes an image or URL (`background`, `background-image`, `content`,
 * `cursor`, `mask*`, `list-style*`, `border-image`, `filter`), anything
 * that lifts an element out of the page (`position` other than
 * relative/static, `z-index`, `transform`, `inset`), and the legacy
 * script hooks (`behavior`, `-moz-binding`).
 */
const ALLOWED_STYLE_PROPERTIES = new Set([
  // Set by KaTeX through `element.style`
  'background-color', 'border-bottom-width', 'border-color', 'border-right-style',
  'border-right-width', 'border-style', 'border-top-width', 'border-width', 'bottom',
  'color', 'height', 'left', 'margin', 'margin-left', 'margin-right', 'margin-top',
  'min-width', 'padding-left', 'position', 'text-shadow', 'top', 'vertical-align', 'width',
  // Layout + typography for `{style=…}` and mermaid's `<img>` sizing
  'align-items', 'aspect-ratio', 'border', 'border-bottom', 'border-bottom-color',
  'border-bottom-style', 'border-left', 'border-left-color', 'border-left-style',
  'border-left-width', 'border-radius', 'border-right', 'border-right-color', 'border-top',
  'border-top-color', 'border-top-style', 'box-sizing', 'clear', 'display', 'float',
  'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight', 'gap',
  'justify-content', 'letter-spacing', 'line-height', 'margin-bottom', 'max-height',
  'max-width', 'min-height', 'object-fit', 'object-position', 'opacity', 'padding',
  'padding-bottom', 'padding-right', 'padding-top', 'right', 'text-align',
  'text-decoration', 'text-indent', 'text-transform', 'white-space',
  'word-spacing'
])

const ALLOWED_POSITIONS = new Set(['relative', 'static'])

/** A value is plain tokens: words, numbers, units, `#hex`, `,`, `%`, and simple functions. */
const SAFE_STYLE_VALUE_RE = /^[\w\s#.,%()+\-*/!]*$/

/** Functions that may appear in a value (KaTeX colours, calc for layout). */
const ALLOWED_STYLE_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'calc'])

/** Viewport units let an element outgrow the page box it sits in. */
const VIEWPORT_UNIT_RE = /\d(?:[sdl]?v[wh]|vmin|vmax|v[ib])\b/i

function isSafeStyleValue(property: string, value: string): boolean {
  if (!value || !SAFE_STYLE_VALUE_RE.test(value) || value.includes('/*')) return false
  if (VIEWPORT_UNIT_RE.test(value)) return false
  for (const m of value.matchAll(/([a-z-]+)\s*\(/gi)) {
    if (!ALLOWED_STYLE_FUNCTIONS.has((m[1] ?? '').toLowerCase())) return false
  }
  if (property === 'position' && !ALLOWED_POSITIONS.has(value.toLowerCase())) return false
  return true
}

/**
 * Reduce an inline `style` value to allowlisted declarations. Anything
 * the simple grammar doesn't cover (quotes, escapes, comments, `url()`,
 * `var()`, unknown functions, unknown properties) is dropped one
 * declaration at a time. Returns `''` when nothing survives.
 */
function filterInlineStyle(style: string): string {
  // Escapes and quotes could hide a `;` or a function name from the
  // split below; no legitimate value here needs either.
  if (/[\\"'<>]/.test(style)) return ''
  const kept: string[] = []
  for (const decl of style.split(';')) {
    const colon = decl.indexOf(':')
    if (colon < 0) continue
    const property = decl.slice(0, colon).trim().toLowerCase()
    const value = decl.slice(colon + 1).trim()
    if (!ALLOWED_STYLE_PROPERTIES.has(property) || !isSafeStyleValue(property, value)) continue
    kept.push(`${property}: ${value}`)
  }
  return kept.join('; ')
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * KaTeX's SVG (`\underbrace`, `\overbrace`, `\widehat`, `\overrightarrow`,
 * `\cancel`, `\sqrt`'s radical…): the elements and the attributes
 * each may keep. Without them those symbols render as nothing.
 */
const KATEX_SVG_ATTRS: Readonly<Record<string, ReadonlySet<string>>> = {
  svg: new Set(['width', 'height', 'viewbox', 'preserveaspectratio', 'style']),
  path: new Set(['d']),
  line: new Set(['x1', 'y1', 'x2', 'y2', 'stroke-width'])
}

/** Attributes that only make sense on the KaTeX SVG elements. */
const SVG_ONLY_ATTRS = new Set(['viewbox', 'preserveaspectratio', 'd', 'x1', 'y1', 'x2', 'y2', 'stroke-width'])

function isKatexSvgElement(node: Element): boolean {
  return node.namespaceURI === SVG_NS && node.localName in KATEX_SVG_ATTRS
}

/**
 * SVG survives only where KaTeX puts it: an `<svg>` inside `.katex-html`,
 * `<path>` / `<line>` directly inside such an `<svg>`. Anything else in
 * the SVG namespace is removed with its content.
 */
function onElement(node: Node, data: UponSanitizeElementHookEvent): void {
  if (!(node instanceof Element) || node.namespaceURI !== SVG_NS) return
  const parent = node.parentElement
  const allowed = data.tagName === 'svg'
    ? parent?.namespaceURI !== SVG_NS && parent?.closest('.katex-html') != null
    : (data.tagName === 'path' || data.tagName === 'line') && parent?.namespaceURI === SVG_NS && parent.localName === 'svg'
  if (!allowed) node.parentNode?.removeChild(node)
}

function onAttribute(node: Element, data: UponSanitizeAttributeHookEvent): void {
  if (isKatexSvgElement(node)) {
    if (!KATEX_SVG_ATTRS[node.localName]?.has(data.attrName)) {
      data.keepAttr = false
      return
    }
  } else if (SVG_ONLY_ATTRS.has(data.attrName)) {
    data.keepAttr = false
    return
  }
  if (data.attrName !== 'style') return
  const filtered = filterInlineStyle(data.attrValue)
  if (filtered) {
    data.attrValue = filtered
  } else {
    data.keepAttr = false
  }
}

let purifier: DOMPurify | null = null

function getPurifier(): DOMPurify {
  if (!purifier) {
    // Private instance so the hooks can't leak into (or be removed by)
    // any other DOMPurify user.
    purifier = createDOMPurify(globalThis.window)
    purifier.addHook('uponSanitizeElement', onElement)
    purifier.addHook('uponSanitizeAttribute', onAttribute)
  }
  return purifier
}

/** Sanitise rendered HTML with the pipeline's allowlist. Browser-only. */
export function sanitizeRenderedHtml(html: string): string {
  return getPurifier().sanitize(html, SANITIZE_OPTS)
}
