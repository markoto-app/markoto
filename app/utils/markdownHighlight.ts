import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

// Shared by the editor (EditorPane) and the marketing `::try-it` block.
// Markdown source highlighting. Headings step UP in size (1.5×/1.3×/…)
// AND step through sumi shades — making the document visibly skimmable
// while still reading as "source", not WYSIWYG. Punctuation (#, *, _,
// >, `) dims to sumi-400 so the prose dominates. Links pick up shu so
// the brand colour extends to "this is reference".
//
// Brand caveats:
//   - Weight tops out at 500 (`fontWeight: '500'`); never 600+.
//   - Italic on `t.emphasis` is a deliberate exception to the
//     "italic = AI voice" rule: inside the editor the user is looking
//     at SOURCE, and `*foo*` rendering as italic is the universal
//     markdown convention. Outside the editor, italic stays AI-only.
export const markotoMarkdownHighlight = HighlightStyle.define([
  // Headings — size + weight + colour. Line-height tightened so the
  // larger glyphs don't blow out vertical rhythm. Colours come from
  // `--mk-md-*` vars in main.css so they flip per mode (sumi-950 on
  // cream bg light → sumi-50 on sumi-900 bg dark).
  { tag: t.heading1, fontSize: '1.5em', fontWeight: '500', lineHeight: '1.3', color: 'var(--mk-md-h1)' },
  { tag: t.heading2, fontSize: '1.3em', fontWeight: '500', lineHeight: '1.35', color: 'var(--mk-md-h2)' },
  { tag: t.heading3, fontSize: '1.18em', fontWeight: '500', lineHeight: '1.4', color: 'var(--mk-md-h3)' },
  { tag: t.heading4, fontSize: '1.08em', fontWeight: '500', color: 'var(--mk-md-h4)' },
  { tag: [t.heading5, t.heading6], fontWeight: '500', color: 'var(--mk-md-h56)' },

  // Inline emphasis
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '500', color: 'var(--mk-md-strong)' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--mk-md-mark)' },

  // Links + URLs — shu (brand) flipped 500→400 in dark for contrast
  { tag: t.link, color: 'var(--mk-md-link)' },
  { tag: t.url, color: 'var(--mk-md-link)', textDecoration: 'underline' },

  // Inline `code` and fenced blocks. Background lifts ONE shade off
  // the editor bg per mode (sumi-100 light, sumi-800 dark) so the
  // chip reads as elevated rather than as a hole.
  { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--mk-md-code-fg)', background: 'var(--mk-md-code-bg)', padding: '0 3px', borderRadius: '3px' },

  // Block-level structural marks
  { tag: t.quote, color: 'var(--mk-md-quote)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--mk-md-list)' },
  { tag: t.contentSeparator, color: 'var(--mk-md-mark)' },

  // Markdown punctuation (#, *, _, >, `) — dim so structure recedes
  { tag: [t.processingInstruction, t.punctuation, t.meta], color: 'var(--mk-md-mark)' },

  // Inside fenced code blocks: nested language tags from
  // `codeLanguages: languages`. Muted sumi range so JS keywords don't
  // shout at heading-level intensity.
  { tag: t.keyword, color: 'var(--mk-md-syntax)', fontWeight: '500' },
  { tag: t.string, color: 'var(--mk-md-syntax)' },
  { tag: t.number, color: 'var(--mk-md-syntax)' },
  { tag: t.comment, color: 'var(--mk-md-comment)', fontStyle: 'italic' },
  { tag: t.variableName, color: 'var(--mk-md-syntax-strong)' },
  { tag: t.typeName, color: 'var(--mk-md-syntax-strong)' },
  { tag: t.function(t.variableName), color: 'var(--mk-md-syntax-strong)' }
])
