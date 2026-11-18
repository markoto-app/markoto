// Image and link targets in imported Markdown: found in one pass, replaced
// in a second once the import knows where each one went (an uploaded image
// of the new document, another imported document). Covers inline images and
// links, reference definitions and HTML `<img src>`. Fenced code blocks are
// left alone, so a code sample that shows Markdown keeps its text. A small
// scanner instead of regular expressions: linear on any input.

const FENCE_CHARS = new Set(['`', '~'])

export interface MarkdownRefs {
  /** Targets of images (inline `![]()`, `<img src>`, and reference definitions). */
  images: string[]
  /** Targets of plain links (inline `[]()` and reference definitions). */
  links: string[]
}

/** A reference found on a line: where its target starts and ends, and whether it is an image. */
interface Ref { start: number, end: number, target: string, image: boolean }

/** A fence opener / closer: 3+ backticks or tildes after at most 3 spaces. */
function fenceOf(line: string): string | null {
  let i = 0
  while (i < 3 && line[i] === ' ') i++
  const ch = line[i]
  if (!ch || !FENCE_CHARS.has(ch)) return null
  let n = 0
  while (line[i + n] === ch) n++
  return n >= 3 ? ch.repeat(n) : null
}

/** Split into lines, calling `fn` only for lines outside fenced code blocks. */
function eachProseLine(markdown: string, fn: (line: string) => string): string {
  const lines = markdown.split('\n')
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const f = fenceOf(line)
    if (fence !== null) {
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = null
      continue
    }
    if (f) {
      fence = f
      continue
    }
    lines[i] = fn(line)
  }
  return lines.join('\n')
}

/** Index of the `]` closing the `[` at `open`, honouring backslash escapes and nesting; -1 if none. */
function closingBracket(line: string, open: number): number {
  let depth = 0
  for (let i = open; i < line.length; i++) {
    const c = line[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '[') depth++
    else if (c === ']' && --depth === 0) return i
  }
  return -1
}

/** The target in `(...)` starting at `paren`: its span (without `<>`) and the `)`. */
function parenTarget(line: string, paren: number): { start: number, end: number, close: number } | null {
  let i = paren + 1
  while (line[i] === ' ') i++
  let start = i
  let end: number
  if (line[i] === '<') {
    const gt = line.indexOf('>', i)
    if (gt === -1) return null
    start = i + 1
    end = gt
    i = gt + 1
  } else {
    while (i < line.length && line[i] !== ' ' && line[i] !== ')') i++
    end = i
  }
  if (end <= start) return null
  // An optional title, then `)`. Anything else after the target means this
  // is not a link (`[a](b and more)`), and its "target" must not be rewritten.
  while (line[i] === ' ') i++
  if (line[i] !== ')' && line[i] !== '"' && line[i] !== '\'' && line[i] !== '(') return null
  const close = line.indexOf(')', i)
  if (close === -1) return null
  return { start, end, close }
}

function inlineRefs(line: string): Ref[] {
  const refs: Ref[] = []
  let i = 0
  while (i < line.length) {
    const open = line.indexOf('[', i)
    if (open === -1) break
    const close = closingBracket(line, open)
    if (close === -1) break
    if (line[close + 1] === '(') {
      const t = parenTarget(line, close + 1)
      if (t) {
        refs.push({ start: t.start, end: t.end, target: line.slice(t.start, t.end), image: open > 0 && line[open - 1] === '!' })
        i = t.close + 1
        continue
      }
    }
    i = open + 1
  }
  return refs
}

/** The quoted value of a `src` attribute name at `attr`: its span, or the index to continue from. */
function srcValue(line: string, attr: number): { start: number, end: number } | { next: number } {
  let j = attr + 3
  while (line[j] === ' ') j++
  if (line[j] !== '=') return { next: j }
  j++
  while (line[j] === ' ') j++
  const quote = line[j]
  if (quote !== '"' && quote !== '\'') return { next: j }
  const stop = line.indexOf(quote, j + 1)
  return stop === -1 ? { next: line.length } : { start: j + 1, end: stop }
}

function imgTagRefs(line: string): Ref[] {
  const refs: Ref[] = []
  const lower = line.toLowerCase()
  let i = 0
  while (i < line.length) {
    const tag = lower.indexOf('<img', i)
    if (tag === -1) break
    const end = lower.indexOf('>', tag)
    const attr = lower.indexOf('src', tag)
    if (attr === -1 || (end !== -1 && attr > end)) {
      i = tag + 4
      continue
    }
    const value = srcValue(line, attr)
    if ('next' in value) {
      i = value.next
      continue
    }
    refs.push({ start: value.start, end: value.end, target: line.slice(value.start, value.end), image: true })
    i = value.end + 1
  }
  return refs
}

/** `[id]: target "title"` at the start of a line. */
function definitionRef(line: string): Ref | null {
  let i = 0
  while (i < 3 && line[i] === ' ') i++
  if (line[i] !== '[') return null
  const close = closingBracket(line, i)
  if (close === -1 || line[close + 1] !== ':') return null
  let j = close + 2
  while (line[j] === ' ') j++
  let start = j
  let end: number
  if (line[j] === '<') {
    const gt = line.indexOf('>', j)
    if (gt === -1) return null
    start = j + 1
    end = gt
  } else {
    while (j < line.length && line[j] !== ' ') j++
    end = j
  }
  return end > start ? { start, end, target: line.slice(start, end), image: false } : null
}

/** Every image and link target of the Markdown, in order, without duplicates. */
export function collectMarkdownRefs(markdown: string): MarkdownRefs {
  const images = new Set<string>()
  const links = new Set<string>()
  eachProseLine(markdown, (line) => {
    for (const r of inlineRefs(line)) (r.image ? images : links).add(r.target)
    for (const r of imgTagRefs(line)) images.add(r.target)
    const def = definitionRef(line)
    if (def) {
      // A definition can serve an image or a link; offer it as both.
      images.add(def.target)
      links.add(def.target)
    }
    return line
  })
  return { images: [...images], links: [...links] }
}

/**
 * Replace targets: images through `images`, links through `links` (a target
 * missing from its map stays as written). Titles and alt texts are kept.
 */
export function rewriteMarkdownRefs(markdown: string, images: ReadonlyMap<string, string>, links: ReadonlyMap<string, string>): string {
  if (images.size === 0 && links.size === 0) return markdown
  return eachProseLine(markdown, (line) => {
    const def = definitionRef(line)
    const refs = [...inlineRefs(line), ...imgTagRefs(line), ...(def ? [def] : [])].sort((a, b) => b.start - a.start)
    let out = line
    for (const r of refs) {
      const next = r === def ? images.get(r.target) ?? links.get(r.target) : (r.image ? images : links).get(r.target)
      if (next !== undefined) out = out.slice(0, r.start) + next + out.slice(r.end)
    }
    return out
  })
}

/** A `data:image/…;base64,…` URI: its media type and bytes, or null. */
export function decodeImageDataUri(target: string): { mediaType: string, bytes: Uint8Array } | null {
  if (!target.toLowerCase().startsWith('data:image/')) return null
  const comma = target.indexOf(',')
  if (comma === -1) return null
  const head = target.slice(5, comma).toLowerCase()
  if (!head.endsWith(';base64')) return null
  const mediaType = head.slice(0, -';base64'.length)
  if (!/^image\/[a-z0-9.+-]{1,40}$/.test(mediaType)) return null
  const bytes = Buffer.from(target.slice(comma + 1).replace(/\s/g, ''), 'base64')
  return bytes.length === 0 ? null : { mediaType, bytes: new Uint8Array(bytes) }
}
