import type MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'

/**
 * Marker classes for template CSS, set while the Markdown is parsed (so
 * the sanitised HTML carries them; no selector gymnastics with `:has()` or
 * sibling combinators, which paged.js rewrites — docs/TEMPLATE-WORKFLOW.md):
 *
 * - `markoto-labelled` on a paragraph that opens with a bold run-in label
 *   (`**Theorem 7.3.** text`, `**Pricing:** CHF 39`): the label ends with
 *   `.`, `:`, `!` or `?` and text follows it. An alert whose first
 *   paragraph is labelled gets `markoto-alert-labelled` (lecture notes: the
 *   label names the theorem, the alert title can go).
 * - `markoto-endpoint` on a paragraph holding exactly `METHOD /path`
 *   (`POST /payments`), and on the `<pre>` of an `http` code fence holding
 *   exactly that; the method sits in `span.markoto-http-method`, the path
 *   in `span.markoto-http-path` (API references).
 *
 * Plain `<p>` / `<pre>` / `<span>` with classes — the sanitiser allows them.
 */
const LABEL_END = /[.:!?]$/
const ENDPOINT = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)[ \t]+(\/\S*)$/

export const LABELLED_CLASS = 'markoto-labelled'
export const ALERT_LABELLED_CLASS = 'markoto-alert-labelled'
export const ENDPOINT_CLASS = 'markoto-endpoint'

/** Text of inline tokens (text, code, nested emphasis). */
function inlineText(tokens: Token[]): string {
  return tokens.map(t => t.type === 'text' || t.type === 'code_inline' ? t.content : t.type === 'softbreak' || t.type === 'hardbreak' ? ' ' : '').join('')
}

/** Does this inline token (a paragraph's content) open with a bold run-in label followed by more text? */
export function opensWithLabel(inline: Token | undefined): boolean {
  const children = inline?.children ?? []
  let i = 0
  while (children[i]?.type === 'text' && children[i]?.content.trim() === '') i++
  if (children[i]?.type !== 'strong_open') return false
  let depth = 0
  let close = -1
  for (let j = i; j < children.length; j++) {
    const t = children[j]
    if (t?.type === 'strong_open') depth++
    if (t?.type === 'strong_close' && --depth === 0) {
      close = j
      break
    }
  }
  if (close < 0) return false
  const label = inlineText(children.slice(i + 1, close)).trim()
  if (!label || !LABEL_END.test(label)) return false
  return children.slice(close + 1).some(t => t.type !== 'softbreak' && t.type !== 'hardbreak' && !(t.type === 'text' && t.content.trim() === ''))
}

function endpointMatch(inline: Token | undefined): RegExpExecArray | null {
  const children = inline?.children ?? []
  if (children.length !== 1 || children[0]?.type !== 'text') return null
  return ENDPOINT.exec(children[0].content.trim())
}

function endpointHtml(md: MarkdownIt, method: string, path: string): string {
  return `<span class="markoto-http-method">${method}</span> <span class="markoto-http-path">${md.utils.escapeHtml(path)}</span>`
}

export function markersPlugin(md: MarkdownIt): void {
  md.core.ruler.push('markoto_markers', (state: StateCore) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (t?.type !== 'paragraph_open') continue
      const inline = tokens[i + 1]
      if (opensWithLabel(inline)) {
        t.attrJoin('class', LABELLED_CLASS)
        // The first paragraph of an alert (right after its title).
        const prev = tokens[i - 1]
        if (prev?.type === 'alert_title') {
          for (let j = i - 2; j >= 0; j--) {
            const open = tokens[j]
            if (open?.type === 'alert_open') {
              open.attrJoin('class', ALERT_LABELLED_CLASS)
              break
            }
          }
        }
        continue
      }
      const ep = endpointMatch(inline)
      if (ep && inline) {
        t.attrJoin('class', ENDPOINT_CLASS)
        const html = new state.Token('html_inline', '', 0)
        html.content = endpointHtml(md, ep[1] ?? '', ep[2] ?? '')
        inline.children = [html]
      }
    }
  })

  // ```http fence holding only `METHOD /path` → an endpoint line.
  const previous = md.renderer.rules.fence
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const lang = (token?.info ?? '').trim().split(/\s+/)[0]?.toLowerCase()
    const ep = lang === 'http' ? ENDPOINT.exec((token?.content ?? '').trim()) : null
    if (ep) {
      return `<pre class="${ENDPOINT_CLASS}"><code class="hljs language-http">${endpointHtml(md, ep[1] ?? '', ep[2] ?? '')}</code></pre>\n`
    }
    return previous ? previous(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)
  }
}
