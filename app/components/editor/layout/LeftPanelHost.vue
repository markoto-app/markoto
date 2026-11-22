<script setup lang="ts">
import type { EditorView } from '@codemirror/view'
import type { OutlineHeading } from '~/utils/editor/documentOutline'
import type { LeftPanelTab } from '~/utils/editor/leftPanel'
import LeftPanel from './LeftPanel.vue'

// Places the editor's left panel on a desktop (the phone shows it in the
// bottom sheet). From xl it is a 260px column beside the editor; narrower it
// lies over the editor, so editor and preview keep their width and the page
// never scrolls sideways. The overlay closes on Escape or a click outside it.

const props = defineProps<{
  open: boolean
  /** Beside the editor (xl and up) rather than over it. */
  inline: boolean
  /** The panel's props and listeners (`useEditorLeftPanel().panelProps`). */
  panel: {
    'tab': LeftPanelTab
    'source': string
    'view': EditorView | null
    'docId': string
    'workspaceId': string | null
    'workspaceRole': string | null
    'onUpdate:tab': (tab: LeftPanelTab) => void
    'onSelectHeading': (heading: OutlineHeading) => void
  }
}>()
const emit = defineEmits<{ close: [] }>()

const host = useTemplateRef<HTMLElement>('host')
const content = useTemplateRef<{ focusTabs: () => void }>('content')

onClickOutside(host, () => {
  if (props.open && !props.inline) emit('close')
}, { ignore: ['[data-testid="left-panel-toggle"]'] })

// Escape inside the overlay closes it and gives focus back to the toggle.
// Not on the column: there Escape belongs to the tree and the editor.
useEventListener(host, 'keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Escape' || props.inline) return
  e.stopPropagation()
  emit('close')
  document.querySelector<HTMLElement>('[data-testid="left-panel-toggle"]')?.focus()
})

defineExpose({ focusTabs: () => content.value?.focusTabs() })
</script>

<template>
  <aside
    v-if="open"
    ref="host"
    :class="inline
      ? 'w-[260px] shrink-0 h-full border-r border-default'
      : 'absolute inset-y-0 left-0 z-30 w-[260px] max-w-[calc(100%-3rem)] border-r border-default'"
    class="hidden sm:block overflow-hidden"
    :data-overlay="inline ? undefined : 'true'"
    data-testid="left-panel-host"
  >
    <LeftPanel
      ref="content"
      v-bind="panel"
      @close="emit('close')"
    />
  </aside>
</template>
