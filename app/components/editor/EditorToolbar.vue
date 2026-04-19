<script setup lang="ts">
import type { EditorView } from '@codemirror/view'
import { toggleWrap, toggleHeading, toggleLinePrefix, toggleOrderedList, toggleCode, insertBlock } from '~/utils/editorCommands'

const { t } = useI18n()

const props = defineProps<{
  view: EditorView | null
  readOnly: boolean
  docId: string
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
  // Table + HR — common insertions worth a one-click toolbar slot in
  // addition to the Insert menu entries.
  { icon: 'i-lucide-table', label: t('editor.table'), action: withView(v => insertBlock(v, '\n| Column 1 | Column 2 |\n|----------|----------|\n| Cell     | Cell     |\n')) },
  { icon: 'i-lucide-minus', label: t('editor.horizontalRule'), action: withView(v => insertBlock(v, '\n---\n')) }
])
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

    <input
      ref="imageInput"
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
      class="hidden"
      @change="onImageSelected"
    >
  </div>
</template>
