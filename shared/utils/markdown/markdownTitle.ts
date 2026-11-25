/**
 * The text without its title line: a level-1 ATX heading on the first
 * non-blank line, plus the blank lines after it. Used for themes that set
 * the title in a title block on page 1 (papers): the heading is the
 * document title there, and left in the body it would print twice.
 * Anything else (no heading first, a level-2 heading) is returned as is.
 */
export function withoutTitleHeading(markdown: string): string {
  const lines = markdown.split('\n')
  let i = 0
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  if (!/^\s{0,3}#[ \t]+\S/.test(lines[i] ?? '')) return markdown
  i++
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  return lines.slice(i).join('\n')
}

/**
 * Title-block layouts set the document title themselves, so a leading
 * `# Title` in the text would print it twice.
 */
export function showsTitleItself(cover: { enabled: boolean, layout: string, showTitle: boolean }): boolean {
  return cover.enabled && cover.layout === 'title-block' && cover.showTitle
}

const TITLE_MAX_LENGTH = 255

/**
 * The text of the first level-1 ATX heading (`# Title`) outside code
 * fences, without closing hashes and inline emphasis markers. '' when the
 * text has none.
 */
export function firstH1(markdown: string): string {
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^\s{0,3}#[ \t]+(\S.*)$/.exec(line)
    if (!m?.[1]) continue
    const words = m[1].trim().split(/\s+/)
    // An optional closing sequence of hashes ("# Title ##") is not part of the title.
    while (words.length > 1 && /^#+$/.test(words.at(-1) ?? '')) words.pop()
    const text = words.join(' ').replace(/[*_`~]/g, '').trim()
    if (text) return text.slice(0, TITLE_MAX_LENGTH)
  }
  return ''
}

/** Default titles of a new document in every UI language. */
const DEFAULT_TITLES = new Set(['Untitled', 'Unbenannt', 'Sans titre', 'Sin título', '無題', '无标题'])

/**
 * The title a document should switch to after its first heading changed
 * from `previousH1` to `nextH1`, or null to keep `current`. The title
 * follows the heading while it is still a default ("Untitled") or the
 * heading's previous text; once someone renames the document to anything
 * else, it stays as they set it.
 */
export function followHeadingTitle(current: string, previousH1: string, nextH1: string): string | null {
  const title = current.trim()
  if (!nextH1 || nextH1 === title) return null
  const automatic = title === '' || DEFAULT_TITLES.has(title) || (previousH1 !== '' && title === previousH1)
  return automatic ? nextH1 : null
}
