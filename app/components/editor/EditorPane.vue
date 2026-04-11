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
const view = ref<EditorView | null>(null)

// Compartments allow dynamic reconfiguration of readOnly state
const editableCompartment = new Compartment()
const readOnlyCompartment = new Compartment()

onMounted(() => {
  if (!editorRef.value) return

  const extensions = [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    EditorView.theme({
      '&': { height: '100%', fontSize: '15px' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, monospace' },
      '.cm-content': { padding: '16px 20px', minHeight: '100%' },
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
    }),
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

onUnmounted(() => {
  view.value?.destroy()
})

defineExpose({ view })
</script>

<template>
  <div ref="editorRef" class="h-full overflow-hidden" />
</template>
