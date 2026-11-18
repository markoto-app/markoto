<script setup lang="ts">
import type { ExplorerItem } from '~/utils/explorer/model'
import { splitSnippet } from '~~/shared/utils/documents/searchQuery'
import { folderNameProblem } from '~~/shared/utils/documents/folderName'
import { useExplorerDragDrop } from '~/composables/explorer/useExplorerDnd'

// The name cell of one explorer row: icon, name (or the inline rename
// field), the search snippet. It also makes its table row a drag source
// and, for folders, a drop target, and sets the row's ARIA state (the table
// component renders the <tr>, this cell owns what is specific to the item).

const props = defineProps<{
  item: ExplorerItem
  selected: boolean
  focused: boolean
  renaming: boolean
  /** 1-based position in the whole list (virtualised rows need it for screen readers). */
  rowIndex: number
  draggable: boolean
}>()

const emit = defineEmits<{
  'rename-commit': [name: string]
  'rename-cancel': []
}>()

const { t } = useI18n()
const root = useTemplateRef<HTMLElement>('root')
const row = computed(() => root.value?.closest('tr') ?? null)

const { over } = useExplorerDragDrop(row, {
  key: () => props.item.key,
  folderId: () => props.item.kind === 'folder' ? props.item.id : undefined,
  enabled: () => props.draggable
})

watchEffect(() => {
  const tr = row.value
  if (!tr) return
  tr.setAttribute('aria-selected', String(props.selected))
  tr.setAttribute('aria-rowindex', String(props.rowIndex + 1))
  tr.dataset.key = props.item.key
  tr.dataset.kind = props.item.kind
  tr.classList.toggle('explorer-drop-over', over.value)
  tr.classList.toggle('explorer-focus', props.focused)
  // Styled here, not through the table's row options: changing those re-renders
  // every row, which swallowed the second click of a double click.
  tr.classList.toggle('explorer-selected', props.selected)
})

// Inline rename: Enter or leaving the field commits, Escape cancels.
const draft = ref('')
const input = useTemplateRef<{ inputRef?: HTMLInputElement }>('input')
/** Until then a focus taken away from the field is taken back (see below). */
let holdFocusUntil = 0
function inputEl(): HTMLInputElement | null {
  return input.value?.inputRef ?? null
}

// A menu that just closed (context menu, "New") holds the focus while it is
// open and hands it back to its trigger as it closes, a moment after the
// rename started. So the field keeps taking the focus, every frame, for a
// short while: the first attempts land in the menu's focus trap, a later
// one sticks once the menu is gone.
function holdFocus() {
  const el = inputEl()
  if (!props.renaming || !el || Date.now() > holdFocusUntil) return
  if (document.activeElement !== el) {
    el.focus()
    // Like a file manager: the whole name is selected, ready to be typed over.
    if (document.activeElement === el && el.value === props.item.label) el.select()
  }
  requestAnimationFrame(holdFocus)
}
watch(() => props.renaming, async (on) => {
  if (!on) return
  holdFocusUntil = Date.now() + 700
  draft.value = props.item.label
  await nextTick()
  holdFocus()
}, { immediate: true })

function onBlur() {
  if (Date.now() < holdFocusUntil) return
  commit()
}

// The field never got the focus (or lost it without a blur we saw): a click
// elsewhere still ends the rename, and Escape anywhere still cancels it.
useEventListener(document, 'pointerdown', (e: PointerEvent) => {
  if (!props.renaming || Date.now() < holdFocusUntil) return
  const el = inputEl()
  if (el && e.target instanceof Node && el.contains(e.target)) return
  commit()
}, { capture: true })
useEventListener(document, 'keydown', (e: KeyboardEvent) => {
  if (!props.renaming || e.key !== 'Escape' || document.activeElement === inputEl()) return
  e.preventDefault()
  cancel()
})

const problem = computed(() => {
  if (!props.renaming) return null
  if (props.item.kind === 'folder') return folderNameProblem(draft.value)
  return draft.value.trim() === '' ? 'empty' : draft.value.trim().length > 255 ? 'too-long' : null
})

let finished = false
watch(() => props.renaming, (on) => {
  if (on) finished = false
})
function commit() {
  if (finished || problem.value) return
  finished = true
  const name = draft.value.trim()
  if (name === props.item.label) emit('rename-cancel')
  else emit('rename-commit', name)
}
function cancel() {
  if (finished) return
  finished = true
  emit('rename-cancel')
}

const snippet = computed(() => props.item.kind === 'doc' && props.item.doc.snippet ? splitSnippet(props.item.doc.snippet) : [])
</script>

<template>
  <div
    ref="root"
    class="flex items-start gap-2.5 min-w-0 py-0.5"
  >
    <UIcon
      :name="item.kind === 'folder' ? 'i-lucide-folder' : 'i-lucide-file-text'"
      class="size-4 shrink-0 mt-0.5"
      :class="item.kind === 'folder' ? 'text-default' : 'text-muted'"
      aria-hidden="true"
    />
    <div class="min-w-0 flex-1">
      <div
        v-if="renaming"
        class="space-y-1"
        @click.stop
        @dblclick.stop
        @keydown.stop
      >
        <UInput
          ref="input"
          v-model="draft"
          size="xs"
          class="w-full max-w-md"
          :color="problem ? 'error' : 'neutral'"
          :aria-label="t('explorer.renameLabel')"
          :aria-invalid="problem ? 'true' : 'false'"
          data-testid="explorer-rename-input"
          @keydown.enter.prevent="commit"
          @keydown.esc.prevent="cancel"
          @blur="onBlur"
        />
        <p
          v-if="problem"
          class="text-xs text-error"
          role="alert"
        >
          {{ t(`explorer.nameProblem.${problem}`) }}
        </p>
      </div>
      <template v-else>
        <span
          class="block truncate"
          :class="item.kind === 'folder' ? 'font-medium' : ''"
          data-testid="explorer-item-name"
        >{{ item.label }}</span>
        <span
          v-if="snippet.length > 0"
          class="block text-xs text-muted truncate"
        >
          <template
            v-for="(part, i) in snippet"
            :key="i"
          >
            <mark
              v-if="part.match"
              class="bg-transparent text-default font-medium"
            >{{ part.text }}</mark>
            <template v-else>{{ part.text }}</template>
          </template>
        </span>
      </template>
    </div>
  </div>
</template>
