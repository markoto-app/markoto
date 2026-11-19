// Markdown with the open suggestions written in CriticMarkup
// (https://fletcher.github.io/MultiMarkdown-6/syntax/critic.html):
//   {++added++}  {--deleted--}  {~~old~>new~~}
// The usual export has the accepted text only; this one lets a reviewer
// see every proposal in any text editor, or hand the file to a tool that
// reads CriticMarkup. Pure: text and resolved ranges in, string out.

export interface CriticSuggestion {
  from: number
  to: number
  text: string
}

/**
 * The text with every suggestion marked up. Suggestions are applied back to
 * front; a range overlapping one already marked is clipped to what is left,
 * so the markers never nest.
 */
export function toCriticMarkup(text: string, suggestions: readonly CriticSuggestion[]): string {
  const sorted = [...suggestions].sort((a, b) => b.to - a.to || b.from - a.from)
  let out = text
  let floor = Number.POSITIVE_INFINITY
  for (const s of sorted) {
    const to = Math.min(s.to, floor)
    const from = Math.min(s.from, to)
    const mark = markFor(out.slice(from, to), s.text)
    if (mark === null) continue
    out = out.slice(0, from) + mark + out.slice(to)
    floor = from
  }
  return out
}

function markFor(struck: string, text: string): string | null {
  if (struck && text) return `{~~${struck}~>${text}~~}`
  if (struck) return `{--${struck}--}`
  if (text) return `{++${text}++}`
  return null
}
