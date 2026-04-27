<script setup lang="ts">
import { EditorView, keymap, drawSelection } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { yCollab } from 'y-codemirror.next'
import type { Text as YText, UndoManager } from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { dictationExtensions } from '~/utils/dictationExtensions'
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

// Mobile: 16px font prevents iOS auto-zoom on focus; wider line-height aids touch reading.
function buildResponsiveTheme(mobile: boolean) {
  return EditorView.theme({
    '&': { height: '100%', fontSize: mobile ? '16px' : '15px' },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'ui-monospace, monospace',
      lineHeight: mobile ? '1.7' : '1.5'
    },
    '.cm-content': {
      padding: mobile ? '12px 16px' : '16px 20px',
      minHeight: '100%'
    },
    '.cm-gutters': { display: 'none' },
    '.cm-focused': { outline: 'none' },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#528bff',
      borderLeftWidth: '2px'
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.04)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(82, 139, 255, 0.2) !important' },
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
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
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
let flashTimer: ReturnType<typeof setTimeout> | null = null
function flashCommentRange(from: number, to: number) {
  if (!view.value) return
  view.value.dispatch({
    effects: [
      setFlashRange.of({ from, to }),
      EditorView.scrollIntoView(from, { y: 'center' })
    ]
  })
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    if (view.value) view.value.dispatch({ effects: setFlashRange.of(null) })
    flashTimer = null
  }, 1200)
}

onUnmounted(() => {
  if (flashTimer) clearTimeout(flashTimer)
})

defineExpose({ view, flashCommentRange })
</script>

<template>
  <div
    ref="editorRef"
    class="h-full overflow-hidden"
  />
</template>
