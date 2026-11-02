<script setup lang="ts">
import { EditorView, keymap, drawSelection } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { markdown, markdownLanguage, markdownKeymap, pasteURLAsLink } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { yCollab } from 'y-codemirror.next'
import type { Text as YText, UndoManager } from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { dictationExtensions } from '~/utils/dictationExtensions'
import { formattingKeymap } from '~/utils/editorCommands'
import { commentDecorationsExtension, setCommentRanges, setFlashRange, type CommentRange } from '~/utils/commentDecorations'

const props = withDefaults(defineProps<{
  ytext: YText
  awareness: Awareness
  undoManager: UndoManager
  readOnly: boolean
  /**
   * Active comment anchors to underline. The host (EditorLayout) keeps
   * this in sync with the Y.js comments array; we dispatch a
   * `setCommentRanges` effect whenever it changes so the decoration
   * field rebuilds.
   */
  commentRanges?: readonly CommentRange[]
  /** Click on a comment underline → invoked with the id. */
  onCommentClick?: (id: string) => void
}>(), {
  commentRanges: () => [],
  onCommentClick: undefined
})

const editorRef = ref<HTMLElement | null>(null)
// `shallowRef` (not `ref`) because EditorView is a class with private fields
// that Vue's deep-reactivity Proxy strips. With `ref`, consumers see a
// structurally-similar-but-incomplete EditorView type (missing
// dispatchTransactions/_root/plugins/…) and typecheck breaks. shallowRef
// preserves the exact instance without wrapping it.
const view = shallowRef<EditorView | null>(null)

// Compartments allow dynamic reconfiguration of readOnly and responsive theme
const editableCompartment = new Compartment()
const readOnlyCompartment = new Compartment()
const responsiveThemeCompartment = new Compartment()

// Matches Tailwind's sm: breakpoint (640px and up = not-mobile)
const isMobile = useMediaQuery('(max-width: 639px)')

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
const markotoMarkdownHighlight = HighlightStyle.define([
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

// Mobile: 16px font prevents iOS auto-zoom on focus; wider line-height aids touch reading.
function buildResponsiveTheme(mobile: boolean) {
  return EditorView.theme({
    '&': { height: '100%', fontSize: mobile ? '16px' : '15px' },
    '.cm-scroller': {
      overflow: 'auto',
      // Proportional Inter, not mono — markoto is a writing tool, not
      // a code editor. Inline `code` and fenced blocks still render
      // mono via the `t.monospace` rule in `markotoMarkdownHighlight`.
      fontFamily: 'var(--font-sans)',
      lineHeight: mobile ? '1.7' : '1.65'
    },
    '.cm-content': {
      // Generous top padding so the doc title doesn't kiss the
      // toolbar — gives the page a "sheet of paper" feel, like the
      // first line is set down ~1.5cm from the top edge.
      padding: mobile ? '32px 16px 16px' : '64px 20px 24px',
      minHeight: '100%',
      // Editorial reading width on desktop. Centers prose so 1500px
      // monitors don't stretch lines past readability. Mobile keeps
      // viewport-width.
      maxWidth: mobile ? 'none' : '70ch',
      marginLeft: 'auto',
      marginRight: 'auto'
    },
    '.cm-gutters': { display: 'none' },
    '.cm-focused': { outline: 'none' },
    // currentColor inherits the editor's prose colour — sumi-950 in
    // light, sumi-100 in dark — so cursor + selection stay in brand
    // automatically per mode without a CSS-var dance.
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'currentColor',
      borderLeftWidth: '2px'
    },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, currentColor 4%, transparent)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, currentColor 18%, transparent) !important' },
    '.cm-ySelectionInfo': {
      fontSize: '11px',
      padding: '2px 6px',
      borderRadius: '4px',
      opacity: '0.9',
      fontFamily: 'system-ui, sans-serif',
      fontWeight: '500'
    },
    // Dictation ghost text. Muted + italic so it reads as
    // "provisional" rather than committed text; the trailing
    // blinking dot is a pseudo-element driven by the global
    // `cm-dictation-ghost-blink` keyframes in main.css.
    '.cm-dictation-ghost': {
      opacity: '0.55',
      fontStyle: 'italic',
      pointerEvents: 'none',
      userSelect: 'none',
      color: 'var(--ui-text-muted)'
    },
    '.cm-dictation-ghost::after': {
      content: '"▍"',
      marginLeft: '2px',
      animation: 'cm-dictation-ghost-blink 1.1s steps(2, end) infinite'
    },
    // Comment-anchor underline. Subtle yellow background + dashed
    // underline reads as "annotated" without competing with text
    // semantics (highlights, links). Cursor is pointer so the click
    // target is discoverable.
    '.cm-comment-anchor': {
      backgroundColor: 'rgba(234, 179, 8, 0.16)',
      borderBottom: '1px dashed rgba(234, 179, 8, 0.7)',
      cursor: 'pointer'
    },
    '.cm-comment-anchor:hover': {
      backgroundColor: 'rgba(234, 179, 8, 0.28)'
    },
    // Flash applied for ~1.2s after the user clicks a thread in the
    // sidebar — ringed amber highlight that pulses once so the eye
    // catches the connection between the click and the doc location.
    '.cm-comment-flash': {
      backgroundColor: 'rgba(234, 179, 8, 0.55)',
      animation: 'cm-comment-flash-pulse 1.2s ease-out 1'
    }
  })
}

onMounted(() => {
  if (!editorRef.value) return

  const extensions = [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(markotoMarkdownHighlight),
    // markdownKeymap continues `- `/`> `/`1. ` prefixes on Enter and
    // strips them on Backspace at line start. Goes BEFORE defaultKeymap
    // so it wins the Enter/Backspace bindings — defaultKeymap's plain
    // newline would otherwise swallow the markdown-aware behaviour.
    // formattingKeymap: Mod-b / Mod-i (the shortcuts the Format menu shows).
    keymap.of([...formattingKeymap, ...markdownKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    pasteURLAsLink,
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    // Mobile keyboard hints: sentence case, autocorrect on
    EditorView.contentAttributes.of({
      autocapitalize: 'sentences',
      autocorrect: 'on',
      spellcheck: 'true'
    }),
    responsiveThemeCompartment.of(buildResponsiveTheme(isMobile.value)),
    editableCompartment.of(EditorView.editable.of(!props.readOnly)),
    readOnlyCompartment.of(EditorState.readOnly.of(props.readOnly)),
    yCollab(props.ytext, props.awareness, { undoManager: props.undoManager }),
    // Dictation ghost-text decoration. No-op when dictation isn't
    // active (state field starts empty). See `dictationExtensions.ts`.
    ...dictationExtensions,
    // Comment-anchor underlines + flash + click → focus router. The
    // decoration sets are driven by `setCommentRanges` effects
    // dispatched in the watcher below.
    commentDecorationsExtension({ onCommentClick: props.onCommentClick })
  ]

  view.value = new EditorView({
    state: EditorState.create({
      // Provide initial content from Y.js — needed when the editor mounts
      // after the doc is already synced (e.g. after password verification)
      doc: props.ytext.toString(),
      extensions
    }),
    parent: editorRef.value
  })

  // Seed the comment-anchor decorations from the initial prop so newly
  // joined sessions immediately see existing comment underlines.
  if (props.commentRanges.length > 0) {
    view.value.dispatch({ effects: setCommentRanges.of([...props.commentRanges]) })
  }
})

// Watcher for comment range updates. The host updates `commentRanges`
// whenever the Y.js comments array changes; we forward via effect so
// the decoration field rebuilds. `deep` because the items themselves
// are POJOs that change in place.
watch(() => props.commentRanges, (ranges) => {
  if (!view.value) return
  view.value.dispatch({ effects: setCommentRanges.of([...ranges]) })
}, { deep: true })

// Watch readOnly prop changes and reconfigure the editor dynamically
watch(() => props.readOnly, (readOnly) => {
  if (!view.value) return
  view.value.dispatch({
    effects: [
      editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
      readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly))
    ]
  })
})

// Reconfigure the responsive theme when the viewport crosses the mobile breakpoint
watch(isMobile, (mobile) => {
  if (!view.value) return
  view.value.dispatch({
    effects: responsiveThemeCompartment.reconfigure(buildResponsiveTheme(mobile))
  })
})

onUnmounted(() => {
  view.value?.destroy()
})

// Briefly highlight a range and scroll it into view. Called by the
// parent when the user clicks a comment thread in the sidebar — the
// flash is what makes the click→jump connection legible.
// Comment-flash highlight: 1.2s post-scroll-into-view the highlight
// clears so it doesn't linger. Restart cancels the in-flight timer.
const flashClear = useTimeoutFn(() => {
  if (view.value) view.value.dispatch({ effects: setFlashRange.of(null) })
}, 1200, { immediate: false })
function flashCommentRange(from: number, to: number) {
  if (!view.value) return
  view.value.dispatch({
    effects: [
      setFlashRange.of({ from, to }),
      EditorView.scrollIntoView(from, { y: 'center' })
    ]
  })
  flashClear.start()
}

defineExpose({ view, flashCommentRange })
</script>

<template>
  <div
    ref="editorRef"
    class="h-full overflow-hidden"
  />
</template>
