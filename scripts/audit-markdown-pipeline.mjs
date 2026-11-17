// Full-pipeline audit: markdown-it + every plugin AS CONFIGURED + DOMPurify
// with the SAME allow-list we ship. Catches anything sanitized away after
// rendering. Mirrors app/utils/markdown/renderMarkdown.ts as closely as Bun permits
// (skips the CSS side-import since that doesn't affect HTML semantics).
//
// Run:  bun scripts/audit-markdown-pipeline.mjs
//
// When to run:
//   - Before adding a syntax claim to server/utils/agentic/markdownReference.ts.
//     Run the case through this script first; only document syntaxes the
//     script confirms actually survive the full pipeline.
//   - After adding a new markdown-it plugin or bumping a plugin's version.
//   - After changing the DOMPurify ALLOWED_TAGS / ALLOWED_ATTR list in
//     app/utils/markdown/renderMarkdown.ts: anything the sanitizer now strips
//     silently will surface as a CLEAN-vs-RAW diff.
//
// Reads this file as truth: if a syntax fails here, don't tell the AI it works.

import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import * as emojiMod from 'markdown-it-emoji'
import footnote from 'markdown-it-footnote'
import { attrs } from '@mdit/plugin-attrs'
import { mark } from '@mdit/plugin-mark'
import { ins } from '@mdit/plugin-ins'
import { sub } from '@mdit/plugin-sub'
import { sup } from '@mdit/plugin-sup'
import { dl } from '@mdit/plugin-dl'
import { abbr } from '@mdit/plugin-abbr'
import { figure } from '@mdit/plugin-figure'
import { imgSize } from '@mdit/plugin-img-size'
import { alert } from '@mdit/plugin-alert'
import { katex } from '@mdit/plugin-katex'
import anchor from 'markdown-it-anchor'
import toc from 'markdown-it-toc-done-right'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'

const win = new JSDOM('').window
const DOMPurify = createDOMPurify(win)

const emoji = emojiMod.full || emojiMod.default || emojiMod

// Pagebreak rule: copied verbatim from app/utils/markdown/renderMarkdown.ts
function pagebreakPlugin(md) {
  const re = /^\s*<!--\s*pagebreak\s*-->\s*$/i
  md.block.ruler.before('paragraph', 'pagebreak', (state, startLine, _endLine, silent) => {
    const pos = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]
    const line = state.src.slice(pos, max)
    if (!re.test(line)) return false
    if (silent) return true
    const t = state.push('html_block', '', 0)
    t.content = '<div class="page-break"></div>'
    t.map = [startLine, startLine + 1]
    state.line = startLine + 1
    return true
  }, { alt: [] })
}

// Comment rule: copied verbatim from app/utils/markdown/renderMarkdown.ts.
// Strips `<!-- ... -->` (block + inline) so writers can leave private
// notes that don't surface in preview/PDF.
function commentPlugin(md) {
  md.block.ruler.before('paragraph', 'comment', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]
    const firstLine = state.src.slice(start, max)
    if (!firstLine.startsWith('<!--')) return false
    const inlineCloseIdx = firstLine.indexOf('-->', 4)
    if (inlineCloseIdx !== -1) {
      if (firstLine.slice(inlineCloseIdx + 3).trim() !== '') return false
      if (silent) return true
      state.line = startLine + 1
      return true
    }
    let line = startLine + 1
    while (line < endLine) {
      const lineStart = state.bMarks[line] + state.tShift[line]
      const lineEnd = state.eMarks[line]
      const lineText = state.src.slice(lineStart, lineEnd)
      const closeIdx = lineText.indexOf('-->')
      if (closeIdx !== -1) {
        if (lineText.slice(closeIdx + 3).trim() !== '') return false
        if (silent) return true
        state.line = line + 1
        return true
      }
      line++
    }
    return false
  })
  md.inline.ruler.before('text', 'comment_inline', (state) => {
    if (state.src.codePointAt(state.pos) !== 0x3C) return false
    if (state.src.slice(state.pos, state.pos + 4) !== '<!--') return false
    const end = state.src.indexOf('-->', state.pos + 4)
    if (end === -1) return false
    state.pos = end + 3
    return true
  })
}

// Same as `alertTitle` in renderMarkdown.ts: the kind, capitalised.
function alertTitle(tokens, idx) {
  const name = tokens[idx].markup
  return `<p class="markdown-alert-title">${name.charAt(0).toUpperCase()}${name.slice(1)}</p>\n`
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: true })
  .use(taskLists, { enabled: true })
  .use(emoji)
  .use(footnote)
  .use(attrs)
  .use(mark)
  .use(ins)
  .use(sub)
  .use(sup)
  .use(dl)
  .use(abbr)
  .use(figure)
  .use(imgSize)
  .use(alert, { alertNames: ['note', 'tip', 'important', 'warning', 'caution'], titleRenderer: alertTitle })
  .use(katex, { output: 'htmlAndMathml', throwOnError: false, strict: false })
  .use(anchor)
  .use(toc, { listType: 'ul', level: [1, 2, 3, 4] })
  .use(pagebreakPlugin)
  .use(commentPlugin)

// Same as renderMarkdown.ts: bare domains stay links (linkify-it 6 default is off).
md.linkify.set({ fuzzyLink: true })

// SAME allow-list as app/utils/markdown/renderMarkdown.ts
const SANITIZE_OPTS = {
  ALLOWED_TAGS: [
    'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'div', 'dl',
    'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'i', 'img', 'input', 'ins', 'li', 'mark', 'nav', 'ol', 'p', 'pre',
    's', 'section', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td',
    'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
    'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'mtext',
    'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mover', 'munder',
    'munderover', 'mspace', 'mstyle', 'mpadded', 'menclose', 'mtable',
    'mtr', 'mtd'
  ],
  ALLOWED_ATTR: [
    'href', 'src', 'alt', 'title', 'target', 'rel',
    'class', 'id',
    'type', 'checked', 'disabled',
    'width', 'height',
    'style',
    'mathvariant', 'displaystyle', 'scriptlevel', 'encoding',
    'aria-hidden', 'role'
  ],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|[^:]*(?:\/|#|$))/i
}

function run(name, input) {
  const raw = md.render(input)
  const clean = String(DOMPurify.sanitize(raw, SANITIZE_OPTS))
  const lostChars = raw.length - clean.length
  const changed = raw !== clean
  console.log(`── ${name} ──`)
  console.log(`IN:\n${input}`)
  console.log(`RAW:\n${raw}`)
  if (changed) {
    console.log(`CLEAN (diff, ${lostChars} chars lost):\n${clean}`)
  } else {
    console.log('CLEAN: (identical to raw)')
  }
  console.log()
}

// ============ GAPS FROM FIRST AUDIT ============

run('pagebreak', 'Before\n\n<!-- pagebreak -->\n\nAfter')
run('pagebreak case-insensitive', '<!-- PageBreak -->')
run('pagebreak with weird spacing', '<!--  pagebreak  -->')

run('reference-style link', 'See [the spec][spec] for details.\n\n[spec]: https://example.com/spec')
run('bare URL linkify', 'Visit https://example.com for more.')
run('email linkify', 'Contact foo@bar.com.')
run('bare domain linkify', 'See www.example.com and example.org.')

run('multiple footnotes', 'Text[^1] with [^note2] multiple.\n\n[^1]: First.\n[^note2]: Second.')

run('abbr defined BEFORE use', '*[SGML]: Standard Generalized Markup Language\n\nThe SGML lineage…')
run('abbr case sensitivity', '*[HTML]: HyperText Markup Language\n\nhtml vs HTML, only uppercase abbr matches.')

run('KaTeX matrix', String.raw`$$\begin{pmatrix} a & b \\ c & d \end{pmatrix}$$`)
run('KaTeX multi-equation (aligned)', String.raw`$$\begin{aligned} x &= y + 1 \\ y &= z - 2 \end{aligned}$$`)
run('KaTeX with dollar in prose', String.raw`He paid \$5, not $5 (which would be math).`)

run('alert with list inside', '> [!NOTE]\n> Items:\n> - one\n> - two')
run('alert with nested bold', '> [!WARNING]\n> This is **strong** warning.')
run('alert with lowercase kind', '> [!note]\n> lowercase kind')
run('alert wrong kind', '> [!DANGER]\n> unsupported kind')

run('attrs with data-*', 'A paragraph.\n{data-foo="bar"}')
run('attrs with aria', '[link](x){aria-label="clicky"}')
run('attrs with role', '# Heading {role="banner"}')

run('DL with multiple paragraphs', 'Term\n: first paragraph\n\n  second paragraph inside same definition')

run('table inside blockquote', '> | A | B |\n> |---|---|\n> | 1 | 2 |')

run('duplicate headings (anchor)', '# Intro\n\nsome content\n\n# Intro\n\nmore')

run('code fence unknown language (mermaid detection target)',
  '```mermaid\nflowchart LR\n  A --> B\n```')

run('code fence with hljs language', '```javascript\nconst x = 1;\n```')

run('task list nested', '- [ ] parent\n  - [ ] child a\n  - [x] child b')

run('image with alt AND title AND attrs all at once',
  '![alt text](cat.jpg "visible caption"){.centered width=50%}')

run('link inside image (clickable image)', '[![alt](cat.jpg)](https://example.com)')

run('emoji in heading', '## :rocket: Launch plan')

run('inline HTML stripped', '<script>alert(1)</script><b>allowed?</b>and text')
run('data URI image (should block)', '![x](data:image/png;base64,AAAA)')

run('pagebreak rendered through DOMPurify?', '<!-- pagebreak -->')

// ============ COMMENTS ============

run('comment block single-line', 'Before\n\n<!-- TODO: rewrite -->\n\nAfter')
run('comment block multi-line', 'Before\n\n<!--\nThis is a private note\nspanning lines\n-->\n\nAfter')
run('comment inline mid-paragraph', 'This is text <!-- a private note --> with more text.')
run('comment inline at start', '<!-- note --> Real content starts here.')
run('comment inline at end', 'Content here. <!-- TODO -->')
run('multiple inline comments', 'a <!-- one --> b <!-- two --> c')
run('comment with markdown inside (NOT rendered)', '<!-- **bold** _italic_ [link](x) -->')
run('comment does NOT swallow trailing text', '<!-- note --> Real content.')
run('pagebreak still wins over comment', 'Before\n\n<!-- pagebreak -->\n\nAfter')
run('unterminated comment falls back to literal', 'Before\n\n<!-- never closed\n\nmore prose')
run('comment inside code fence stays literal', '```\n<!-- not a comment in code -->\n```')
