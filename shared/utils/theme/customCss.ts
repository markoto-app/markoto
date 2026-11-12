import parse from 'css-tree/parser'
import walk from 'css-tree/walker'
import generate from 'css-tree/generator'
import { ident } from 'css-tree/utils'
import type { CssNode, List, ListItem } from 'css-tree'
import {
  CUSTOM_CSS_MAX_BYTES,
  customCssByteLength,
  type CustomCssIssue,
  type CustomCssIssueCode,
  type CustomCssResult
} from '../../types/customCss'
import { ID_PATTERN } from '../../config/identifiers'

/**
 * Sanitizer for a document's custom CSS (`theme.customCss`).
 *
 * ONE module, used on both sides of the wire:
 *   - WRITE time (`meta.put`, saved-theme + workspace-default saves, the
 *     AI / MCP `update_theme` tool): any issue → the write is rejected
 *     with the issue list (400 `theme/custom-css-invalid`).
 *   - RENDER time (live preview iframe, browser print, server PDF/PNG
 *     page): the returned `css` is what gets inlined. Mandatory because
 *     `ymeta.theme` can be written straight over Y.js by any editor,
 *     bypassing every write-path check.
 *
 * Security model:
 *   - The input is parsed with css-tree into an AST; every check runs on
 *     the AST with identifiers DECODED (`u\72l(`, `\000075rl(`, `@IMPORT`,
 *     `e\78pression(` all normalise before comparison). Comments are
 *     dropped by the parser. The output is css-tree's re-serialisation of
 *     the cleaned AST — the raw input is never passed through.
 *   - At-rules are allow-listed (`@media`, `@supports`, `@page` + margin
 *     boxes, `@keyframes`, `@container`, `@layer`, `@font-feature-values`).
 *     `@import`, `@namespace`, `@font-face`, `@property`, `@counter-style`,
 *     `@document` … are rejected; `@charset` is dropped silently.
 *   - `url()` (and the strings inside `image-set()` / `image()` /
 *     `cross-fade()` / `src()`) may only point at this document's own
 *     uploads (`/api/files/<docId>/<fileId>`, relative or on an allowed
 *     app origin) or a base64 `data:image/{png,jpeg,gif,webp}` URL.
 *     `data:image/svg+xml` is refused (see `checkUrl`).
 *   - `expression()`, `behavior`, `-moz-binding`, and `javascript:` /
 *     `vbscript:` anywhere (strings, URLs, identifiers, raw values) are
 *     rejected. Custom-property values are parsed too (`parseCustomProperty`),
 *     so `--x: url(http://…)` is caught where it is declared, not only
 *     where `var(--x)` uses it.
 *   - `var()` / `env()` / `attr()` are refused inside image-producing
 *     functions (`image-set()`, `image()`, `cross-fade()`, `src()`,
 *     `element()`): their value is only known in the browser, so a URL
 *     parked in a custom property would bypass the URL check.
 *   - Input nested deeper than `MAX_NESTING_DEPTH`, or that makes the
 *     parser throw, fails closed (empty CSS + a `syntax` issue).
 *   - Anything css-tree could only keep as an unparsed `Raw` chunk must be
 *     free of `(`, `\`, `@` and `<` — otherwise it is dropped.
 *   - HTML breakout: the output ends up inside a `<style>` element, so
 *     every `<` is re-escaped as the CSS escape `\3c ` (only strings can
 *     legitimately contain one; the escape is equivalent there). CDO/CDC
 *     (`<!--` / `-->`) tokens and preserved "bang" comments are dropped.
 *     The result therefore never contains `</style`, `<!--` or `<script`.
 *
 * The CSS is scoped by construction: it is only ever applied inside the
 * preview iframe (its own document) or the print/render page, never the
 * app shell.
 */

export interface SanitizeCustomCssOptions {
  /**
   * The document the CSS belongs to. Only `/api/files/<docId>/…` URLs of
   * this id survive. `null` = no document context (saved themes,
   * workspace default themes): any document's upload path passes the
   * write check, and the render-time pass against the real doc drops
   * the foreign ones.
   */
  docId: string | null
  /**
   * Absolute app origins (e.g. `https://markoto.app`) whose
   * `/api/files/…` URLs are accepted and normalised to the relative path.
   */
  allowedOrigins?: readonly string[]
  /**
   * Maps every surviving own-upload URL (normalised to
   * `/api/files/<docId>/<fileId>`) to the URL emitted. The server render
   * page uses it to add its `?token=` file-access JWT to the document's
   * confirmed uploads (its headless Chromium has no session cookie).
   */
  fileUrl?: (path: string) => string
}

const ALLOWED_AT_RULES = new Set([
  'media',
  'supports',
  'page',
  // paged.js footnote area inside @page
  'footnote',
  'keyframes',
  'container',
  'layer',
  'font-feature-values',
  'styleset',
  'stylistic',
  'character-variant',
  'swash',
  'ornaments',
  'annotation',
  // @page margin boxes
  'top-left-corner', 'top-left', 'top-center', 'top-right', 'top-right-corner',
  'bottom-left-corner', 'bottom-left', 'bottom-center', 'bottom-right', 'bottom-right-corner',
  'left-top', 'left-middle', 'left-bottom',
  'right-top', 'right-middle', 'right-bottom'
])

const FORBIDDEN_PROPERTIES = new Set(['behavior', 'binding', 'link', 'link-source'])

const FORBIDDEN_FUNCTIONS = new Set(['expression'])

/** Functions whose string arguments are URLs. */
const URL_FUNCTIONS = new Set(['url', 'src', 'image-set', 'image', 'cross-fade'])

/**
 * Functions that produce an image from their arguments. A substitution
 * function inside one of them is refused: `image-set(var(--p) 1x)` with
 * `--p: "http://…"` only becomes a URL in the browser, after this
 * sanitizer looked at a harmless-looking string in a custom property.
 */
const IMAGE_ARG_FUNCTIONS = new Set([...URL_FUNCTIONS, 'element'])

/** Values substituted by the browser at computed-value time. */
const SUBSTITUTION_FUNCTIONS = new Set(['var', 'env', 'attr'])

/**
 * Deepest `{` / `(` / `[` nesting accepted. css-tree's parser and walker
 * recurse per level, so thousands of levels overflow the stack; real
 * stylesheets stay far below this.
 */
const MAX_NESTING_DEPTH = 32

const SCRIPT_SCHEME_RE = /(?:java|vb)script:/i

const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Z0-9+/]+={0,2}$/i
const SVG_DATA_RE = /^data:image\/svg/i

const ID_PART = ID_PATTERN
const FILE_PATH_RE = new RegExp(String.raw`^/api/files/(${ID_PART})/(${ID_PART}\.(?:png|jpe?g|gif|webp))$`, 'i')

/** Strip a vendor prefix (`-webkit-keyframes` → `keyframes`). */
function unprefixed(name: string): string {
  const m = /^-[a-z]+-(.+)$/.exec(name)
  return m?.[1] ?? name
}

/**
 * Drop ASCII whitespace + control characters. Browsers ignore them inside
 * a URL scheme (`java\tscript:`), so scheme checks compare on this.
 */
function squash(s: string): string {
  let out = ''
  for (const ch of s) {
    if (ch.charCodeAt(0) > 0x20) out += ch
  }
  return out
}

function decodedName(raw: string): string {
  return ident.decode(raw).toLowerCase()
}

function truncate(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

type UrlCheck
  = | { ok: true, value: string }
    | { ok: false, code: CustomCssIssueCode, message: string }

/**
 * Decide whether a URL may stay, and normalise it.
 *
 * `data:image/svg+xml` is refused even though an SVG used as a CSS image
 * runs in the browser's script-less "secure static image" mode: SVG is a
 * document format with its own nested `<style>`/`url()` surface that this
 * sanitizer can't see into, and the raster formats cover every legitimate
 * use (a texture, an icon, a rasterised logo).
 */
function checkUrl(raw: string, opts: SanitizeCustomCssOptions): UrlCheck {
  const value = raw.trim()
  // Browsers drop ASCII whitespace/control chars inside a scheme
  // (`java\tscript:`), so compare on a squashed copy.
  const squashed = squash(value)
  if (SCRIPT_SCHEME_RE.test(squashed)) {
    return { ok: false, code: 'script-url', message: 'javascript: and vbscript: URLs are not allowed.' }
  }
  if (/^data:/i.test(squashed)) return checkDataUrl(squashed)
  return checkFileUrl(value, opts)
}

function checkDataUrl(squashed: string): UrlCheck {
  if (SVG_DATA_RE.test(squashed)) {
    return { ok: false, code: 'svg-data-url', message: 'SVG data URLs are not allowed. Use a PNG, JPEG, GIF or WebP data URL, or upload the image to this document.' }
  }
  if (DATA_IMAGE_RE.test(squashed)) return { ok: true, value: squashed }
  return { ok: false, code: 'url', message: 'Only base64 data:image/png, jpeg, gif or webp URLs are allowed.' }
}

/** The path of a root-relative URL, or of an absolute one on an allowed app origin (no query, no fragment). */
function appPathOf(value: string, opts: SanitizeCustomCssOptions): string | null {
  if (value.startsWith('/') && !value.startsWith('//')) return value
  if (!/^https?:\/\//i.test(value)) return null
  try {
    const parsed = new URL(value)
    return opts.allowedOrigins?.includes(parsed.origin) && !parsed.search && !parsed.hash ? parsed.pathname : null
  } catch {
    return null
  }
}

/** Only this document's own uploads (`/api/files/<docId>/<fileId>`). */
function checkFileUrl(value: string, opts: SanitizeCustomCssOptions): UrlCheck {
  const path = appPathOf(value, opts)
  const match = path === null ? null : FILE_PATH_RE.exec(path)
  if (!match) {
    return {
      ok: false,
      code: 'url',
      message: 'url() may only point at an image uploaded to this document or a data:image URL. External and relative links are not allowed.'
    }
  }
  if (opts.docId !== null && match[1] !== opts.docId) {
    return { ok: false, code: 'other-doc-file', message: 'This image belongs to another document. Upload it to this document and use its URL instead.' }
  }
  const ownPath = `/api/files/${match[1]}/${match[2]}`
  return { ok: true, value: opts.fileUrl ? opts.fileUrl(ownPath) : ownPath }
}

/** A Raw chunk css-tree couldn't parse may only be inert text. */
function isInertRaw(text: string): boolean {
  return !/[()\\@<]/.test(text) && !SCRIPT_SCHEME_RE.test(text.replaceAll(/\s/g, ''))
}

const OPENING_BRACKETS = new Set(['{', '(', '['])
const CLOSING_BRACKETS = new Set(['}', ')', ']'])

/**
 * Bracket nesting depth of `input`, ignoring brackets inside strings and
 * comments. Returns early once `limit` is exceeded.
 */
function nestingDepth(input: string, limit: number): number {
  let depth = 0
  let max = 0
  // A scanner: strings, escapes and comments advance the index inside the body.
  let i = -1
  while (++i < input.length) {
    const ch = input[i] ?? ''
    if (ch === '"' || ch === '\'') {
      i = endOfString(input, i)
    } else if (ch === '/' && input[i + 1] === '*') {
      const end = input.indexOf('*/', i + 2)
      if (end < 0) break
      i = end + 1
    } else if (ch === '\\') {
      i++
    } else if (OPENING_BRACKETS.has(ch)) {
      depth++
      max = Math.max(max, depth)
      if (max > limit) return max
    } else if (CLOSING_BRACKETS.has(ch) && depth > 0) {
      depth--
    }
  }
  return max
}

/** Index of the quote closing the string that opens at `start` (`input.length` when unterminated). */
function endOfString(input: string, start: number): number {
  const quote = input[start]
  let i = start
  while (++i < input.length) {
    const ch = input[i]
    if (ch === '\\') i++
    else if (ch === quote) return i
  }
  return i
}

function failClosed(message: string): CustomCssResult {
  return { css: '', issues: [{ code: 'syntax', message, line: 1, column: 1 }], urls: [] }
}

interface Frame {
  node: CssNode
  item: ListItem<CssNode> | null
  list: List<CssNode> | null
}

export function sanitizeCustomCss(input: string, opts: SanitizeCustomCssOptions): CustomCssResult {
  if (typeof input !== 'string' || input.trim() === '') return { css: '', issues: [], urls: [] }
  if (nestingDepth(input, MAX_NESTING_DEPTH) > MAX_NESTING_DEPTH) {
    return failClosed(`Custom CSS is nested more than ${MAX_NESTING_DEPTH} levels deep.`)
  }
  try {
    return sanitizeChecked(input, opts)
  } catch {
    // Fail closed: no CSS at all rather than a partial or unchecked result.
    return failClosed('Custom CSS could not be processed.')
  }
}

function sanitizeChecked(input: string, opts: SanitizeCustomCssOptions): CustomCssResult {
  const bytes = customCssByteLength(input)
  if (bytes > CUSTOM_CSS_MAX_BYTES) {
    return {
      css: '',
      issues: [{
        code: 'too-large',
        message: `Custom CSS is ${bytes} bytes; the limit is ${CUSTOM_CSS_MAX_BYTES} bytes.`,
        line: 1,
        column: 1
      }],
      urls: []
    }
  }

  const issues: CustomCssIssue[] = []
  const ast = parse(input, {
    positions: true,
    parseCustomProperty: true,
    onParseError(error) {
      issues.push({
        code: 'syntax',
        message: `Syntax error: ${error.message}`,
        line: error.line,
        column: error.column
      })
    }
  })

  const sanitizer = new SanitizingWalk(opts, issues)
  walk(ast, {
    enter(node: CssNode, item: ListItem<CssNode> | null, list: List<CssNode> | null) {
      sanitizer.enter({ node, item, list })
    },
    leave() {
      sanitizer.leave()
    }
  })
  sanitizer.removeDoomed()

  // URLs that are still in the tree after the removals.
  const urls = new Set<string>()
  walk(ast, (node: CssNode) => {
    const url = sanitizer.keptUrls.get(node)
    if (url !== undefined) urls.add(url)
  })

  // `<` can only survive inside a string (selectors and values can't hold
  // one, Raw chunks with `<` were dropped); `\3c ` is the same character
  // there. This is what guarantees no `</style`, `<!--` or `<script`.
  const css = generate(ast).replaceAll('<', String.raw`\3c `)

  issues.sort((a, b) => a.line - b.line || a.column - b.column)
  return { css, issues, urls: [...urls] }
}

/**
 * One pass over the AST: every node is checked on `enter`; a node that
 * fails removes the smallest meaningful unit around it (its declaration,
 * else its rule / at-rule), applied after the walk so the walk never sees
 * a mutated list. URLs that pass are normalised in place and remembered.
 */
class SanitizingWalk {
  private readonly stack: Frame[] = []
  private readonly doomed = new Set<Frame>()
  readonly keptUrls = new Map<CssNode, string>()

  constructor(private readonly opts: SanitizeCustomCssOptions, private readonly issues: CustomCssIssue[]) {}

  enter(frame: Frame): void {
    this.stack.push(frame)
    this.inspect(frame.node)
  }

  leave(): void {
    this.stack.pop()
  }

  removeDoomed(): void {
    for (const frame of this.doomed) {
      if (frame.list && frame.item) frame.list.remove(frame.item)
    }
  }

  private report(node: CssNode, code: CustomCssIssueCode, message: string, detail?: string): void {
    this.issues.push({
      code,
      message,
      line: node.loc?.start.line ?? 1,
      column: node.loc?.start.column ?? 1,
      ...(detail === undefined ? {} : { detail: truncate(detail) })
    })
  }

  private parentType(): CssNode['type'] | undefined {
    return this.stack.at(-2)?.node.type
  }

  /** Remove the smallest meaningful unit around the current node. */
  private doomEnclosing(): void {
    const declaration = this.stack.findLast(f => f.node.type === 'Declaration')
    const unit = declaration ?? this.stack.findLast(f => f.node.type === 'Atrule' || f.node.type === 'Rule')
    const target = unit ?? this.stack.at(-1)
    if (target) this.doomed.add(target)
  }

  private doomSelf(): void {
    const current = this.stack.at(-1)
    if (current) this.doomed.add(current)
  }

  private insideUrlFunction(): boolean {
    return this.stack.some(f => f.node.type === 'Function' && URL_FUNCTIONS.has(unprefixed(decodedName(f.node.name))))
  }

  /** An enclosing function (not the current node) produces an image. */
  private insideImageFunction(): boolean {
    return this.stack.slice(0, -1).some(f => f.node.type === 'Function' && IMAGE_ARG_FUNCTIONS.has(unprefixed(decodedName(f.node.name))))
  }

  private applyUrl(node: CssNode & { value: string }): void {
    const res = checkUrl(node.value, this.opts)
    if (res.ok) {
      node.value = res.value
      this.keptUrls.set(node, res.value)
    } else {
      this.report(node, res.code, res.message, node.value)
      this.doomEnclosing()
    }
  }

  private inspect(node: CssNode): void {
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- css-tree has ~40 node types; only these need a decision, every other node is inert (default)
    switch (node.type) {
      case 'Comment':
      case 'CDO':
      case 'CDC':
        this.doomSelf()
        return
      case 'Raw':
        this.inspectRaw(node)
        return
      case 'Atrule':
        this.inspectAtrule(node)
        return
      case 'Declaration':
        this.inspectDeclaration(node)
        return
      case 'Function':
        this.inspectFunction(node)
        return
      case 'Url':
        this.applyUrl(node)
        return
      case 'String':
        this.inspectString(node)
        return
      case 'Identifier':
        if (SCRIPT_SCHEME_RE.test(ident.decode(node.name))) {
          this.report(node, 'script-url', 'javascript: and vbscript: URLs are not allowed.', node.name)
          this.doomEnclosing()
        }
        return
      default:
    }
  }

  private inspectRaw(node: CssNode & { type: 'Raw' }): void {
    const host = this.parentType()
    if (host === 'StyleSheet' || host === 'Block' || host === undefined) {
      // Garbage at rule level — the parse error was already reported.
      this.doomSelf()
    } else if (host === 'Rule') {
      // Unparseable selector: drop the whole rule.
      this.doomEnclosing()
    } else if (!isInertRaw(node.value)) {
      this.report(node, 'value', 'This value could not be parsed safely and was removed.', node.value)
      this.doomEnclosing()
    }
  }

  private inspectAtrule(node: CssNode & { type: 'Atrule' }): void {
    const name = decodedName(node.name)
    if (name === 'charset') {
      this.doomSelf()
      return
    }
    if (!ALLOWED_AT_RULES.has(unprefixed(name))) {
      const hint = name === 'font-face' ? ' Pick fonts in the theme\'s font settings instead.' : ''
      this.report(node, 'at-rule', `@${name} is not allowed in custom CSS.${hint}`, `@${name}`)
      this.doomSelf()
    }
  }

  private inspectDeclaration(node: CssNode & { type: 'Declaration' }): void {
    const prop = decodedName(node.property)
    if (FORBIDDEN_PROPERTIES.has(unprefixed(prop)) || prop === 'behavior') {
      this.report(node, 'property', `The "${prop}" property is not allowed.`, prop)
      this.doomSelf()
    }
  }

  private inspectFunction(node: CssNode & { type: 'Function' }): void {
    const name = unprefixed(decodedName(node.name))
    if (FORBIDDEN_FUNCTIONS.has(name)) {
      this.report(node, 'function', `${name}() is not allowed.`, `${name}()`)
      this.doomEnclosing()
    } else if (SUBSTITUTION_FUNCTIONS.has(name) && this.insideImageFunction()) {
      this.report(node, 'function', `${name}() is not allowed inside image functions such as image-set(). Write the URL directly.`, `${name}()`)
      this.doomEnclosing()
    }
  }

  private inspectString(node: CssNode & { type: 'String' }): void {
    if (this.insideUrlFunction()) {
      this.applyUrl(node)
    } else if (SCRIPT_SCHEME_RE.test(squash(node.value))) {
      this.report(node, 'script-url', 'javascript: and vbscript: URLs are not allowed.', node.value)
      this.doomEnclosing()
    }
  }
}

/** One-line summary of the first issue, for API error messages + AI tool results. */
export function formatCustomCssIssues(issues: readonly CustomCssIssue[], max = 5): string {
  return issues.slice(0, max)
    .map(i => `line ${i.line}, column ${i.column}: ${i.message}`)
    .join('\n') + (issues.length > max ? `\n(+${issues.length - max} more)` : '')
}

/**
 * Re-target custom CSS at a document it did not come from (applying a
 * saved theme / workspace default, creating a doc from one, the AI
 * applying a base theme). Rules the target can't use — typically
 * `url(/api/files/<otherDoc>/…)` — are removed. When nothing needs
 * removing, the original text (with its formatting) is kept; otherwise
 * the cleaned, re-serialised CSS replaces it.
 */
export function adaptCustomCssToDoc(
  css: string | undefined,
  opts: SanitizeCustomCssOptions
): { css: string | undefined, dropped: CustomCssIssue[] } {
  if (css === undefined || css.trim() === '') return { css, dropped: [] }
  const res = sanitizeCustomCss(css, opts)
  if (res.issues.length === 0) return { css, dropped: [] }
  return { css: res.css, dropped: res.issues }
}

/**
 * Point a duplicated document's custom CSS at the copy's own uploads
 * (`/api/files/<source>/…` → `/api/files/<target>/…`), mirroring the
 * markdown-body rewrite in `server/utils/documents/cloneYjsState.ts`.
 */
export function rewriteCustomCssDocId(css: string | undefined, sourceDocId: string, targetDocId: string): string | undefined {
  if (css === undefined) return undefined
  return css.replaceAll(`/api/files/${sourceDocId}/`, `/api/files/${targetDocId}/`)
}

/**
 * Copy of `theme` whose custom CSS references the target doc's uploads
 * instead of the source's. Used by document duplication for both the
 * `documents.theme` row and the cloned `ymeta.theme`.
 */
export function withThemeDocId<T extends { customCss?: string }>(theme: T, sourceDocId: string, targetDocId: string): T {
  if (!theme.customCss) return theme
  return { ...theme, customCss: rewriteCustomCssDocId(theme.customCss, sourceDocId, targetDocId) }
}
