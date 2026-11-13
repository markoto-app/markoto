import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

// Markdown source highlighting, shared by the editor (EditorPane) and the
// marketing `::try-it` block. Headings step up in size and sumi shade so
// the document is skimmable while still reading as source, not WYSIWYG.
// Punctuation dims so the prose dominates.
//
// Brand constraints:
//   - Weight tops out at 500; never 600+.
//   - Italic on `t.emphasis` is a deliberate exception to the "italic =
//     AI voice" rule: this is source, and `*foo*` as italic is the
//     universal markdown convention.
export const markotoMarkdownHighlight = HighlightStyle.define([
  // Line-height is tightened so the larger glyphs keep the vertical
  // rhythm. Colours come from `--mk-md-*` vars in main.css so they flip
  // per colour mode.
  { tag: t.heading1, fontSize: '1.5em', fontWeight: '500', lineHeight: '1.3', color: 'var(--mk-md-h1)' },
  { tag: t.heading2, fontSize: '1.3em', fontWeight: '500', lineHeight: '1.35', color: 'var(--mk-md-h2)' },
  { tag: t.heading3, fontSize: '1.18em', fontWeight: '500', lineHeight: '1.4', color: 'var(--mk-md-h3)' },
  { tag: t.heading4, fontSize: '1.08em', fontWeight: '500', color: 'var(--mk-md-h4)' },
  { tag: [t.heading5, t.heading6], fontWeight: '500', color: 'var(--mk-md-h56)' },

  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '500', color: 'var(--mk-md-strong)' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--mk-md-mark)' },

  // Links use the brand colour (lightened in dark mode for contrast).
  { tag: t.link, color: 'var(--mk-md-link)' },
  { tag: t.url, color: 'var(--mk-md-link)', textDecoration: 'underline' },

  // The code background sits one shade off the editor background so the
  // chip reads as elevated rather than as a hole.
  { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--mk-md-code-fg)', background: 'var(--mk-md-code-bg)', padding: '0 3px', borderRadius: '3px' },

  { tag: t.quote, color: 'var(--mk-md-quote)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--mk-md-list)' },
  { tag: t.contentSeparator, color: 'var(--mk-md-mark)' },

  // Markdown punctuation (#, *, _, >, `) dims so structure recedes.
  { tag: [t.processingInstruction, t.punctuation, t.meta], color: 'var(--mk-md-mark)' },

  // Nested language tags inside fenced code (`codeLanguages: languages`):
  // a muted range so keywords don't compete with headings.
  { tag: t.keyword, color: 'var(--mk-md-syntax)', fontWeight: '500' },
  { tag: t.string, color: 'var(--mk-md-syntax)' },
  { tag: t.number, color: 'var(--mk-md-syntax)' },
  { tag: t.comment, color: 'var(--mk-md-comment)', fontStyle: 'italic' },
  { tag: t.variableName, color: 'var(--mk-md-syntax-strong)' },
  { tag: t.typeName, color: 'var(--mk-md-syntax-strong)' },
  { tag: t.function(t.variableName), color: 'var(--mk-md-syntax-strong)' }
])
