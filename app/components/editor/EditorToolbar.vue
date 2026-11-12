<script setup lang="ts">
import type { EditorView } from '@codemirror/view'
import { toggleWrap, toggleHeading, toggleLinePrefix, toggleOrderedList, toggleCode, toggleComment, insertBlock, insertAlert, insertMath, insertDiagram, insertPageBreak, insertToc } from '~/utils/editor/editorCommands'

const { t } = useI18n()

const props = defineProps<{
  view: EditorView | null
  readOnly: boolean
  docId: string
  /** Dictation state from the parent's `useVoiceDictation`: 'idle' shows the mic icon, anything else styles the button as active / stop. */
  dictationState?: 'idle' | 'requesting-permission' | 'connecting' | 'recording' | 'error'
}>()

const emit = defineEmits<{
  // Signals the parent to open the shared size-picker modal (same one as the menu's Insert → Table).
  'open-table-picker': []
  // Hoisted so the composable can own the editor/ydoc/awareness wiring; the toolbar only renders and emits.
  'toggle-dictation': []
  // Add a comment on the selection; the parent serializes the anchor and opens the sidebar.
  'create-comment': []
}>()

const dictationActive = computed(() =>
  props.dictationState === 'recording' || props.dictationState === 'connecting'
)
const dictationBusy = computed(() =>
  props.dictationState === 'connecting' || props.dictationState === 'requesting-permission'
)
// Live dictation is Voxtral Realtime (Mistral-only): hidden unless the user's
// transcription provider is Mistral or the instance provides it. Stays visible
// while availability is loading / unknown and while a session runs, so the
// stop button never disappears.
const { liveDictationAvailable, transcriptionLocked } = useAiAvailability()
const { explainLocked } = useAiLockedPrompt()
// Locked: the platform has dictation but the paying plan doesn't.
const dictationLocked = computed(() => !liveDictationAvailable.value && transcriptionLocked.value && !dictationActive.value)
const showDictation = computed(() => liveDictationAvailable.value || dictationActive.value || dictationBusy.value || dictationLocked.value)
function onDictationClick() {
  if (dictationLocked.value) explainLocked('aiVoice')
  else emit('toggle-dictation')
}

const { uploadAndInsert, uploading, error: uploadError } = useImageUpload(props.docId)
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

// `reset: true` so re-picking the same file after a failed upload fires change again.
const { open: openImagePicker, onChange: onImagePicked } = useFileDialog({
  accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml',
  multiple: false,
  reset: true
})

// `uploadAndInsert` reports failures through `uploadError`; it does not reject.
onImagePicked((files) => {
  const file = files?.[0]
  if (!file || !props.view) return
  void uploadAndInsert(file, props.view)
})

// Link wraps as `[text](url)` and selects the placeholder URL so the user can
// type the destination; doesn't fit `toggleWrap`'s symmetric-marker contract.
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
  // `toggleWrap` toggles off already-wrapped selections and trims whitespace first.
  { icon: 'i-lucide-bold', label: t('editor.bold'), action: withView(v => toggleWrap(v, '**')) },
  { icon: 'i-lucide-italic', label: t('editor.italic'), action: withView(v => toggleWrap(v, '*')) },
  { icon: 'i-lucide-strikethrough', label: t('editor.strikethrough'), action: withView(v => toggleWrap(v, '~~')) },
  { icon: 'i-lucide-highlighter', label: t('editor.highlight'), action: withView(v => toggleWrap(v, '==')) },
  { icon: 'i-lucide-underline', label: t('editor.insert'), action: withView(v => toggleWrap(v, '++')) },
  { divider: true },
  // `toggleHeading` replaces an existing prefix (H1 on `## Foo` gives `# Foo`;
  // H1 again gives `Foo`).
  { icon: 'i-lucide-heading-1', label: t('editor.heading'), action: withView(v => toggleHeading(v, 1)) },
  { icon: 'i-lucide-heading-2', label: t('editorCommands.heading2'), action: withView(v => toggleHeading(v, 2)) },
  { icon: 'i-lucide-heading-3', label: t('editorCommands.heading3'), action: withView(v => toggleHeading(v, 3)) },
  { divider: true },
  { icon: 'i-lucide-code', label: t('editor.code'), action: withView(v => toggleCode(v)) },
  { icon: 'i-lucide-quote', label: t('editor.quote'), action: withView(v => toggleLinePrefix(v, '> ')) },
  { icon: 'i-lucide-link', label: t('editor.link'), action: linkAction },
  // Wrapped so the click MouseEvent isn't passed to useFileDialog's open(options?) as an override.
  { icon: 'i-lucide-image', label: t('editor.image'), action: () => openImagePicker() },
  { icon: 'i-lucide-subscript', label: t('editor.subscript'), action: withView(v => toggleWrap(v, '~')) },
  { icon: 'i-lucide-superscript', label: t('editor.superscript'), action: withView(v => toggleWrap(v, '^')) },
  { divider: true },
  // `toggleLinePrefix` swaps any list prefix (ordered list on `- item` gives
  // `1. item`); the same prefix again strips it.
  { icon: 'i-lucide-list', label: t('editor.list'), action: withView(v => toggleLinePrefix(v, '- ')) },
  { icon: 'i-lucide-list-ordered', label: t('editor.orderedList'), action: withView(v => toggleOrderedList(v)) },
  { icon: 'i-lucide-list-checks', label: t('editor.taskList'), action: withView(v => toggleLinePrefix(v, '- [ ] ')) },
  { divider: true },
  // Single-click insertions; Table is a size-picker popover in the template.
  { icon: 'i-lucide-minus', label: t('editor.horizontalRule'), action: withView(v => insertBlock(v, '\n---\n')) },
  { icon: 'i-lucide-scissors-line-dashed', label: t('editor.pageBreak'), action: withView(v => insertPageBreak(v)) },
  { icon: 'i-lucide-list-tree', label: t('menubar.insert.toc'), action: withView(v => insertToc(v)) },
  // Wraps the selection in an HTML comment: kept in the markdown source but
  // stripped from preview/PDF/share. The closed-eye icon reads as "hide this"
  // to non-technical users.
  { icon: 'i-lucide-eye-off', label: t('editor.hideFromPreview'), action: withView(v => toggleComment(v)) }
  // Math, alerts, diagrams and table need a kind/size picker, so they render as
  // dropdowns / popovers in the template; a default on click would diverge from the menu bar.
])

const mathItems = computed(() => [[
  { label: t('menubar.insert.mathInline'), icon: 'i-lucide-pi', onSelect: withView(v => insertMath(v, 'inline')) },
  { label: t('menubar.insert.mathBlock'), icon: 'i-lucide-square-sigma', onSelect: withView(v => insertMath(v, 'block')) }
]])

// Same five variants as the menu bar, so users learn one vocabulary.
const alertItems = computed(() => [[
  { label: t('menubar.insert.alertNote'), icon: 'i-lucide-info', onSelect: withView(v => insertAlert(v, 'NOTE')) },
  { label: t('menubar.insert.alertTip'), icon: 'i-lucide-lightbulb', onSelect: withView(v => insertAlert(v, 'TIP')) },
  { label: t('menubar.insert.alertImportant'), icon: 'i-lucide-megaphone', onSelect: withView(v => insertAlert(v, 'IMPORTANT')) },
  { label: t('menubar.insert.alertWarning'), icon: 'i-lucide-alert-triangle', onSelect: withView(v => insertAlert(v, 'WARNING')) },
  { label: t('menubar.insert.alertCaution'), icon: 'i-lucide-octagon-alert', onSelect: withView(v => insertAlert(v, 'CAUTION')) }
]])

// Eight Mermaid diagram types, each inserting a minimal working example.
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
  <div
    v-if="!readOnly"
    class="flex flex-wrap items-center gap-0.5 px-2 py-1 min-w-0"
    data-testid="editor-toolbar"
  >
    <template
      v-for="(item, i) in actions"
      :key="i"
    >
      <USeparator
        v-if="'divider' in item"
        orientation="vertical"
        class="h-5 mx-1"
      />
      <UTooltip
        v-else
        :text="item.label"
      >
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

    <!-- Dropdowns / a modal so the user picks the variant, matching the menu bar's Insert submenus. -->
    <UTooltip :text="t('editor.table')">
      <UButton
        icon="i-lucide-table"
        color="neutral"
        variant="ghost"
        size="xs"
        @click="emit('open-table-picker')"
      />
    </UTooltip>
    <UDropdownMenu
      :items="mathItems"
      :content="{ align: 'start' }"
    >
      <UTooltip :text="t('menubar.insert.math')">
        <UButton
          icon="i-lucide-sigma"
          color="neutral"
          variant="ghost"
          size="xs"
        />
      </UTooltip>
    </UDropdownMenu>
    <UDropdownMenu
      :items="alertItems"
      :content="{ align: 'start' }"
    >
      <UTooltip :text="t('menubar.insert.alert')">
        <UButton
          icon="i-lucide-message-square-warning"
          color="neutral"
          variant="ghost"
          size="xs"
        />
      </UTooltip>
    </UDropdownMenu>
    <UDropdownMenu
      :items="diagramItems"
      :content="{ align: 'start' }"
    >
      <UTooltip :text="t('menubar.insert.diagram')">
        <UButton
          icon="i-lucide-workflow"
          color="neutral"
          variant="ghost"
          size="xs"
        />
      </UTooltip>
    </UDropdownMenu>

    <!-- Discussion comment on the selection. The icon differs from "Make
         invisible" (i-lucide-eye-off), which wraps the selection in an HTML
         comment; this one lives in the sidebar with replies + resolve. -->
    <USeparator
      orientation="vertical"
      class="h-5 mx-1"
    />
    <UTooltip :text="t('comments.addAria')">
      <UButton
        icon="i-lucide-message-circle"
        color="neutral"
        variant="ghost"
        size="xs"
        :aria-label="t('comments.addAria')"
        @click="emit('create-comment')"
      />
    </UTooltip>

    <!-- Live voice dictation, at the tail so it doesn't shift the muscle-memory
         formatting buttons. Red solid while recording; pulse + animate-ping on
         the icon signal a live mic; the spinner covers permission / connecting. -->
    <USeparator
      v-if="showDictation"
      orientation="vertical"
      class="h-5 mx-1"
    />
    <UTooltip
      v-if="showDictation"
      :text="dictationLocked ? t('ai.locked.aiVoice') : dictationActive || dictationBusy ? t('ai.dictateStop') : t('ai.dictateStart')"
    >
      <UButton
        icon="i-lucide-mic"
        :color="dictationActive || dictationBusy ? 'error' : 'neutral'"
        :variant="dictationActive || dictationBusy ? 'solid' : 'ghost'"
        :class="{ 'dictation-icon-busy': dictationBusy, 'animate-pulse': dictationActive, 'opacity-50': dictationLocked }"
        size="xs"
        :aria-label="dictationActive || dictationBusy ? t('ai.dictateStop') : t('ai.dictateStart')"
        :data-active="dictationActive || dictationBusy ? 'true' : 'false'"
        :data-locked="dictationLocked ? 'true' : undefined"
        data-testid="toolbar-dictate-mic"
        @click="onDictationClick"
      />
    </UTooltip>
  </div>
</template>

<style scoped>
/*
 * Spin the mic icon inside the dictation button, not the whole button:
 * `animate-spin` on the UButton root rotates the entire pill, which reads as
 * a glitch. `:deep` reaches the nested UButton's own scoped styles.
 */
@keyframes dictation-icon-spin {
  to { transform: rotate(360deg); }
}
.dictation-icon-busy :deep(.iconify) {
  animation: dictation-icon-spin 1s linear infinite;
}
</style>
