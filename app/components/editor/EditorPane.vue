<script setup lang="ts">
import { EditorView, keymap, drawSelection } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { markdown, markdownLanguage, pasteURLAsLink } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting } from '@codemirror/language'
import { yCollab } from 'y-codemirror.next'
import type { Text as YText, UndoManager } from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { dictationExtensions } from '~/utils/editor/dictationExtensions'
import { editorKeymap } from '~/utils/editor/collabHistory'
import { promptBarClearance } from '~/utils/editor/promptBarClearance'
import { markotoMarkdownHighlight } from '~/utils/markdown/markdownHighlight'
import { commentDecorationsExtension, setCommentRanges, setFlashRange, type CommentRange } from '~/utils/comments/commentDecorations'
import { citationAssist, type CitationAssistSource } from '~/utils/editor/citationAssist'

const props = withDefaults(defineProps<{
  ytext: YText
  awareness: Awareness
  undoManager: UndoManager
  readOnly: boolean
  /** Comment anchors to underline; the host keeps this in sync with the Y.js comments array and each change dispatches `setCommentRanges` to rebuild the decorations. */
  commentRanges?: readonly CommentRange[]
  /** Click on a comment underline; invoked with the id. */
  onCommentClick?: (id: string) => void
  /** Bibliography keys and labels for `@` completion and hover (citationAssist.ts). */
  citationSource?: CitationAssistSource
}>(), {
  commentRanges: () => [],
  onCommentClick: undefined,
  citationSource: undefined
})

const editorRef = ref<HTMLElement | null>(null)
// `shallowRef`, not `ref`: EditorView has private fields that Vue's deep
// Proxy strips, leaving consumers an incomplete EditorView type and breaking
// typecheck. shallowRef preserves the exact instance.
const view = shallowRef<EditorView | null>(null)

// Compartments allow dynamic reconfiguration of readOnly and the responsive theme.
const editableCompartment = new Compartment()
const readOnlyCompartment = new Compartment()
const responsiveThemeCompartment = new Compartment()

// Matches Tailwind's sm: breakpoint (640px and up is not mobile)
const isMobile = useMediaQuery('(max-width: 639px)')

// Mobile: 16px font prevents iOS auto-zoom on focus; wider line-height aids touch reading.
function buildResponsiveTheme(mobile: boolean) {
  return EditorView.theme({
    '&': { height: '100%', fontSize: mobile ? '16px' : '15px' },
    '.cm-scroller': {
      overflow: 'auto',
      // Proportional Inter, not mono: markoto is a writing tool. Inline `code`
      // and fenced blocks still render mono via `t.monospace` in `markotoMarkdownHighlight`.
      fontFamily: 'var(--font-sans)',
      lineHeight: mobile ? '1.7' : '1.65'
    },
    '.cm-content': {
      // Top padding so the doc title doesn't touch the toolbar (first line sits ~1.5cm down, like a sheet of paper).
      padding: mobile ? '32px 16px 16px' : '64px 20px 24px',
      minHeight: '100%',
      // Reading width on desktop so 1500px monitors don't stretch lines;
      // mobile uses the viewport width.
      maxWidth: mobile ? 'none' : '70ch',
      marginLeft: 'auto',
      marginRight: 'auto'
    },
    '.cm-gutters': { display: 'none' },
    '.cm-focused': { outline: 'none' },
    // currentColor inherits the prose colour (sumi-950 light, sumi-100 dark), so
    // cursor and selection follow the mode without CSS vars.
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
    // Dictation ghost text: muted italic reads as provisional; the trailing
    // blinking dot is a pseudo-element using the global `cm-dictation-ghost-blink` keyframes in main.css.
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
    // Comment-anchor underline: subtle yellow background + dashed underline reads
    // as "annotated" without competing with highlights or links; pointer cursor
    // makes the click target discoverable.
    '.cm-citation-tooltip': {
      maxWidth: '28rem',
      padding: '6px 8px',
      fontSize: '12px',
      lineHeight: '1.45'
    },
    '.cm-comment-anchor': {
      backgroundColor: 'rgba(234, 179, 8, 0.16)',
      borderBottom: '1px dashed rgba(234, 179, 8, 0.7)',
      cursor: 'pointer'
    },
    '.cm-comment-anchor:hover': {
      backgroundColor: 'rgba(234, 179, 8, 0.28)'
    },
    // Flash for ~1.2 s after a sidebar thread click: a ringed amber highlight
    // that pulses once to connect the click to the doc location.
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
    // Formatting, markdown list continuation, defaults, undo / redo on the
    // document's UndoManager. No CodeMirror `history()`: it would record the
    // synced document load and collaborators' edits, so undo could wipe the
    // document (see `collabHistory.ts`).
    keymap.of(editorKeymap),
    pasteURLAsLink,
    drawSelection(),
    EditorView.lineWrapping,
    // The floating AI prompt bar covers the bottom of the editor: when the
    // editor scrolls the caret into view (typing or dictating into the
    // last line, Ctrl+End) the line stops above the bar, not under it.
    // The scroller's bottom padding (main.css) gives it the room.
    EditorView.scrollMargins.of(view => ({ bottom: promptBarClearance(view.scrollDOM) })),
    EditorView.contentAttributes.of({
      autocapitalize: 'sentences',
      autocorrect: 'on',
      spellcheck: 'true'
    }),
    responsiveThemeCompartment.of(buildResponsiveTheme(isMobile.value)),
    editableCompartment.of(EditorView.editable.of(!props.readOnly)),
    readOnlyCompartment.of(EditorState.readOnly.of(props.readOnly)),
    yCollab(props.ytext, props.awareness, { undoManager: props.undoManager }),
    // Dictation ghost-text decoration; a no-op until dictation is active. See `dictationExtensions.ts`.
    ...dictationExtensions,
    // Comment-anchor underlines + flash + click-to-focus router; the decoration
    // sets are driven by `setCommentRanges` effects dispatched by the watcher below.
    commentDecorationsExtension({ onCommentClick: props.onCommentClick }),
    // `@` completion of bibliography keys and labels, hover cards on `@key`.
    ...(props.citationSource ? [citationAssist(props.citationSource)] : [])
  ]

  view.value = new EditorView({
    state: EditorState.create({
      // Initial content from Y.js, needed when the editor mounts after the doc
      // already synced (e.g. after password verification)
      doc: props.ytext.toString(),
      extensions
    }),
    parent: editorRef.value
  })

  // Seed decorations from the initial prop so new sessions see existing underlines at once.
  if (props.commentRanges.length > 0) {
    view.value.dispatch({ effects: setCommentRanges.of([...props.commentRanges]) })
  }
})

// The host updates `commentRanges` whenever the Y.js comments array changes;
// forwarded as an effect so the decoration field rebuilds. `deep` because the
// items are POJOs that change in place.
watch(() => props.commentRanges, (ranges) => {
  if (!view.value) return
  view.value.dispatch({ effects: setCommentRanges.of([...ranges]) })
}, { deep: true })

// Reconfigure the editor when readOnly changes
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

// Called by the parent when the user clicks a comment thread: highlights the
// range and scrolls it into view. The highlight clears after 1.2 s;
// restarting cancels the in-flight timer.
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
