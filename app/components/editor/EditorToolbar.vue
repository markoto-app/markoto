<script setup lang="ts">
import type { EditorView } from '@codemirror/view'

const { t } = useI18n()

const props = defineProps<{
  view: EditorView | null
  readOnly: boolean
  docId: string
}>()

const { uploadAndInsert, uploading, error: uploadError } = useImageUpload(props.docId)
const imageInput = ref<HTMLInputElement | null>(null)
const toast = useToast()
const { loggedIn } = useUserSession()

// Show toast when upload fails
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

function wrapSelection(before: string, after: string) {
  const v = props.view
  if (!v || props.readOnly) return

  const { from, to } = v.state.selection.main
  const selected = v.state.sliceDoc(from, to)
  v.dispatch({
    changes: { from, to, insert: `${before}${selected}${after}` },
    selection: { anchor: from + before.length, head: to + before.length }
  })
  v.focus()
}

function insertPrefix(prefix: string) {
  const v = props.view
  if (!v || props.readOnly) return

  const { from } = v.state.selection.main
  const line = v.state.doc.lineAt(from)
  v.dispatch({
    changes: { from: line.from, to: line.from, insert: prefix }
  })
  v.focus()
}

function openImagePicker() {
  imageInput.value?.click()
}

async function onImageSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !props.view) return

  await uploadAndInsert(file, props.view)

  // Reset the input so the same file can be selected again
  input.value = ''
}

const actions = computed(() => [
  { icon: 'i-lucide-bold', label: t('editor.bold'), action: () => wrapSelection('**', '**') },
  { icon: 'i-lucide-italic', label: t('editor.italic'), action: () => wrapSelection('*', '*') },
  { icon: 'i-lucide-strikethrough', label: t('editor.strikethrough'), action: () => wrapSelection('~~', '~~') },
  { divider: true },
  { icon: 'i-lucide-heading-1', label: t('editor.heading'), action: () => insertPrefix('# ') },
  { icon: 'i-lucide-heading-2', label: 'Heading 2', action: () => insertPrefix('## ') },
  { icon: 'i-lucide-heading-3', label: 'Heading 3', action: () => insertPrefix('### ') },
  { divider: true },
  { icon: 'i-lucide-code', label: t('editor.code'), action: () => wrapSelection('`', '`') },
  { icon: 'i-lucide-quote', label: t('editor.quote'), action: () => insertPrefix('> ') },
  { icon: 'i-lucide-link', label: t('editor.link'), action: () => wrapSelection('[', '](url)') },
  { icon: 'i-lucide-image', label: t('editor.image'), action: openImagePicker },
  { divider: true },
  { icon: 'i-lucide-list', label: t('editor.list'), action: () => insertPrefix('- ') },
  { icon: 'i-lucide-list-ordered', label: t('editor.orderedList'), action: () => insertPrefix('1. ') },
  { icon: 'i-lucide-list-checks', label: t('editor.taskList'), action: () => insertPrefix('- [ ] ') }
])
</script>

<template>
  <div v-if="!readOnly" class="flex items-center gap-0.5 px-2 py-1 overflow-x-auto">
    <template v-for="(item, i) in actions" :key="i">
      <USeparator v-if="item.divider" orientation="vertical" class="h-5 mx-1" />
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

    <!-- Hidden file input for image upload -->
    <input
      ref="imageInput"
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
      class="hidden"
      @change="onImageSelected"
    >
  </div>
</template>
