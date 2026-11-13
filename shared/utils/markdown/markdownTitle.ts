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
