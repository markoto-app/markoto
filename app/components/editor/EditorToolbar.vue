<script setup lang="ts">
import type { EditorView } from '@codemirror/view'
import { toggleWrap, toggleHeading, toggleLinePrefix, toggleOrderedList, toggleCode, insertBlock, insertAlert, insertMath, insertDiagram } from '~/utils/editorCommands'

const { t } = useI18n()

const props = defineProps<{
  view: EditorView | null
  readOnly: boolean
  docId: string
}>()

const emit = defineEmits<{
  // Toolbar Table button just signals the parent to open the shared
  // size-picker modal. Same modal the menu bar's Insert → Table opens —
  // single source of truth for "user wants to insert a table".
  'open-table-picker': []
}>()

const { uploadAndInsert, uploading, error: uploadError } = useImageUpload(props.docId)
const imageInput = ref<HTMLInputElement | null>(null)
const toast = useToast()

watch(uploadError, (err) => {
  if (!err) return
  if (err === 'login_required') {
    toast.add({
      title: t('auth.loginRequired'),
      description: t('image.loginToUpload'),
      icon: 'i-lucide-log-in',
      color: 'warning'
    })
  } else {
    toast.add({
      title: t('image.uploadFailed'),
      description: err,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  }
})

function withView(fn: (v: EditorView) => void) {
  return () => {
    if (!props.view || props.readOnly) return
    fn(props.view)
  }
}

function openImagePicker() {
  imageInput.value?.click()
}

async function onImageSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !props.view) return
  await uploadAndInsert(file, props.view)
  input.value = ''
}

// Link is a special case — wrap as `[text](url)` and select the
// placeholder URL so the user can type the destination immediately.
// Doesn't fit `toggleWrap`'s symmetric-marker contract.
function linkAction() {
  if (!props.view || props.readOnly) return
  const v = props.view
  const { from, to } = v.state.selection.main
  const selected = v.state.sliceDoc(from, to) || 'text'
  const insert = `[${selected}](url)`
  v.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + selected.length + 3, head: from + selected.length + 6 }
  })
  v.focus()
}

const actions = computed(() => [
  // Inline formatting — `toggleWrap` is smart about already-wrapped
  // selections (toggles off) and trims whitespace before wrapping.
  { icon: 'i-lucide-bold', label: t('editor.bold'), action: withView(v => toggleWrap(v, '**')) },
  { icon: 'i-lucide-italic', label: t('editor.italic'), action: withView(v => toggleWrap(v, '*')) },
  { icon: 'i-lucide-strikethrough', label: t('editor.strikethrough'), action: withView(v => toggleWrap(v, '~~')) },
  { icon: 'i-lucide-highlighter', label: t('editor.highlight'), action: withView(v => toggleWrap(v, '==')) },
  { icon: 'i-lucide-underline', label: t('editor.insert'), action: withView(v => toggleWrap(v, '++')) },
  { divider: true },
  // Headings — `toggleHeading` strips/replaces existing prefix, so
  // clicking H1 on a `## Foo` line yields `# Foo` (not `# ## Foo`),
  // and clicking H1 again yields plain `Foo` (toggle off).
  { icon: 'i-lucide-heading-1', label: t('editor.heading'), action: withView(v => toggleHeading(v, 1)) },
  { icon: 'i-lucide-heading-2', label: 'Heading 2', action: withView(v => toggleHeading(v, 2)) },
  { icon: 'i-lucide-heading-3', label: 'Heading 3', action: withView(v => toggleHeading(v, 3)) },
  { divider: true },
  { icon: 'i-lucide-code', label: t('editor.code'), action: withView(v => toggleCode(v)) },
  { icon: 'i-lucide-quote', label: t('editor.quote'), action: withView(v => toggleLinePrefix(v, '> ')) },
  { icon: 'i-lucide-link', label: t('editor.link'), action: linkAction },
  { icon: 'i-lucide-image', label: t('editor.image'), action: openImagePicker },
  { icon: 'i-lucide-subscript', label: t('editor.subscript'), action: withView(v => toggleWrap(v, '~')) },
  { icon: 'i-lucide-superscript', label: t('editor.superscript'), action: withView(v => toggleWrap(v, '^')) },
  { divider: true },
  // Block lists — `toggleLinePrefix` swaps any existing list-style
  // prefix on the line, so clicking ordered-list on `- item` yields
  // `1. item`. Clicking the same prefix again strips it.
  { icon: 'i-lucide-list', label: t('editor.list'), action: withView(v => toggleLinePrefix(v, '- ')) },
  { icon: 'i-lucide-list-ordered', label: t('editor.orderedList'), action: withView(v => toggleOrderedList(v)) },
  { icon: 'i-lucide-list-checks', label: t('editor.taskList'), action: withView(v => toggleLinePrefix(v, '- [ ] ')) },
  { divider: true },
  // HR is a single-click insertion. Table is a popover with a size
  // picker (rendered in the template after this list).
  { icon: 'i-lucide-minus', label: t('editor.horizontalRule'), action: withView(v => insertBlock(v, '\n---\n')) }
  // Math, alerts, diagrams, table need a kind/size picker — rendered as
  // dropdowns / popovers directly in the template after this list.
  // Putting them in `actions` would force a default on the toolbar
  // click, which doesn't match the menu-bar behavior or what users
  // expect.
])


// Math kinds — surfaces inline + block in the toolbar dropdown.
const mathItems = computed(() => [[
  { label: t('menubar.insert.mathInline'), icon: 'i-lucide-pi', onSelect: withView(v => insertMath(v, 'inline')) },
  { label: t('menubar.insert.mathBlock'), icon: 'i-lucide-square-sigma', onSelect: withView(v => insertMath(v, 'block')) }
]])

// Alert kinds — same five variants the menu bar exposes. Keeping the
// option set in sync with the menu bar means users learn one
// vocabulary; toolbar is just a faster path to the same actions.
const alertItems = computed(() => [[
  { label: t('menubar.insert.alertNote'), icon: 'i-lucide-info', onSelect: withView(v => insertAlert(v, 'NOTE')) },
  { label: t('menubar.insert.alertTip'), icon: 'i-lucide-lightbulb', onSelect: withView(v => insertAlert(v, 'TIP')) },
  { label: t('menubar.insert.alertImportant'), icon: 'i-lucide-megaphone', onSelect: withView(v => insertAlert(v, 'IMPORTANT')) },
  { label: t('menubar.insert.alertWarning'), icon: 'i-lucide-alert-triangle', onSelect: withView(v => insertAlert(v, 'WARNING')) },
  { label: t('menubar.insert.alertCaution'), icon: 'i-lucide-octagon-alert', onSelect: withView(v => insertAlert(v, 'CAUTION')) }
]])

// Diagram kinds — eight Mermaid diagram types, each inserting a
// minimal working example.
const diagramItems = computed(() => [[
  { label: t('menubar.insert.diagramFlowchart'), icon: 'i-lucide-git-fork', onSelect: withView(v => insertDiagram(v, 'flowchart')) },
  { label: t('menubar.insert.diagramSequence'), icon: 'i-lucide-arrow-left-right', onSelect: withView(v => insertDiagram(v, 'sequence')) },
  { label: t('menubar.insert.diagramClass'), icon: 'i-lucide-box', onSelect: withView(v => insertDiagram(v, 'class')) },
  { label: t('menubar.insert.diagramState'), icon: 'i-lucide-activity', onSelect: withView(v => insertDiagram(v, 'state')) },
  { label: t('menubar.insert.diagramEr'), icon: 'i-lucide-database', onSelect: withView(v => insertDiagram(v, 'er')) },
  { label: t('menubar.insert.diagramGantt'), icon: 'i-lucide-bar-chart-3', onSelect: withView(v => insertDiagram(v, 'gantt')) },
  { label: t('menubar.insert.diagramPie'), icon: 'i-lucide-pie-chart', onSelect: withView(v => insertDiagram(v, 'pie')) },
  { label: t('menubar.insert.diagramMindmap'), icon: 'i-lucide-network', onSelect: withView(v => insertDiagram(v, 'mindmap')) }
]])
</script>

<template>
  <div v-if="!readOnly" class="flex flex-wrap items-center gap-0.5 px-2 py-1 min-w-0">
    <template v-for="(item, i) in actions" :key="i">
      <USeparator v-if="'divider' in item" orientation="vertical" class="h-5 mx-1" />
      <UTooltip v-else :text="item.label">
        <UButton
          :icon="item.icon"
          color="neutral"
          variant="ghost"
          size="xs"
          :loading="item.label === t('editor.image') && uploading"
          @click="item.action"
        />
      </UTooltip>
    </template>

    <!-- Multi-option insertions (table, math, alert, diagram) — surfaced
         as dropdowns / a modal so the toolbar matches the menu-bar
         Insert submenus and the user picks the variant rather than the
         button forcing a default. Triggers visually match the other
         ghost buttons. -->
    <UTooltip :text="t('editor.table')">
      <UButton
        icon="i-lucide-table"
        color="neutral"
        variant="ghost"
        size="xs"
        @click="emit('open-table-picker')"
      />
    </UTooltip>
    <UDropdownMenu :items="mathItems" :content="{ align: 'start' }">
      <UTooltip :text="t('menubar.insert.math')">
        <UButton icon="i-lucide-sigma" color="neutral" variant="ghost" size="xs" />
      </UTooltip>
    </UDropdownMenu>
    <UDropdownMenu :items="alertItems" :content="{ align: 'start' }">
      <UTooltip :text="t('menubar.insert.alert')">
        <UButton icon="i-lucide-message-square-warning" color="neutral" variant="ghost" size="xs" />
      </UTooltip>
    </UDropdownMenu>
    <UDropdownMenu :items="diagramItems" :content="{ align: 'start' }">
      <UTooltip :text="t('menubar.insert.diagram')">
        <UButton icon="i-lucide-workflow" color="neutral" variant="ghost" size="xs" />
      </UTooltip>
    </UDropdownMenu>

    <input
      ref="imageInput"
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
      class="hidden"
      @change="onImageSelected"
    >
  </div>
</template>
