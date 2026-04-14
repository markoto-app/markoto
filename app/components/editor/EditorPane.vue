<script setup lang="ts">
import { EditorView, keymap, drawSelection } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { yCollab } from 'y-codemirror.next'
import type { Text as YText, UndoManager } from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

const props = defineProps<{
  ytext: YText
  awareness: Awareness
  undoManager: UndoManager
  readOnly: boolean
}>()

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
    yCollab(props.ytext, props.awareness, { undoManager: props.undoManager })
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
})

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

defineExpose({ view })
</script>

<template>
  <div ref="editorRef" class="h-full overflow-hidden" />
</template>
