<script setup lang="ts">
import type { EditorView } from '@codemirror/view'
import type { ReferenceProblem } from '~/utils/markdown/citationResolve'
import type { useBibliography } from '~/composables/document/useBibliography'
import { insertBlock } from '~/utils/editor/editorCommands'

// The References panel bound to the document's bibliography; "cite"
// inserts `[@key]` at the editor's cursor.
const props = defineProps<{
  bibliography: ReturnType<typeof useBibliography>
  language: string
  problems: readonly ReferenceProblem[]
  readOnly: boolean
  /** The person must suggest: citing still works (it becomes a suggestion), the bibliography itself stays as it is (the sync server refuses it). */
  suggestOnly?: boolean
  view: EditorView | null
}>()
const emit = defineEmits<{ close: [] }>()
const { loggedIn } = useUserSession()

function insert(text: string) {
  if (props.view && !props.readOnly) insertBlock(props.view, text)
}
</script>

<template>
  <DocumentReferencesPanel
    :items="bibliography.items.value"
    :style-id="bibliography.style.value"
    :language="language"
    :problems="problems"
    :can-edit="!readOnly && !suggestOnly"
    :can-cite="!readOnly"
    :can-lookup="loggedIn"
    :add-items="bibliography.addItems"
    :has-key="bibliography.hasKey"
    @update:style-id="bibliography.setStyle"
    @remove="bibliography.removeItem"
    @insert="insert"
    @close="emit('close')"
  />
</template>
