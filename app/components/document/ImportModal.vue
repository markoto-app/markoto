<script setup lang="ts">
import type { Text as YText } from 'yjs'

const props = defineProps<{
  ytext: YText
  readOnly: boolean
}>()

const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()

const fileInput = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const importing = ref(false)
const error = ref('')
const importedMarkdown = ref('')
const showConflict = ref(false)

const ACCEPTED = '.docx,.pdf,.pptx,.xlsx,.xls,.html,.htm,.epub'

function selectFile() {
  fileInput.value?.click()
}

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  selectedFile.value = input.files?.[0] || null
  error.value = ''
  // Reset the input so re-selecting the same file fires `change` again.
  if (input) input.value = ''
}

function clearSelection(e: Event) {
  // Stop propagation so the parent dropzone's click-to-pick doesn't fire
  // immediately after we cleared.
  e.stopPropagation()
  selectedFile.value = null
  error.value = ''
}

// Reset transient state whenever the modal closes — by cancel button,
// outside-click, or escape. Otherwise re-opening still shows the previous
// file selection, which reads as "your import is half-done" instead of
// the fresh state the user expects.
watch(open, (isOpen) => {
  if (!isOpen) {
    selectedFile.value = null
    error.value = ''
    importedMarkdown.value = ''
    showConflict.value = false
  }
})

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function doImport() {
  if (!selectedFile.value) return

  importing.value = true
  error.value = ''

  try {
    const formData = new FormData()
    formData.append('file', selectedFile.value)

    const result = await $fetch<{ markdown: string; source: string; filename?: string }>(
      '/api/import',
      { method: 'POST', body: formData }
    )

    importedMarkdown.value = result.markdown

    // If document already has content, show conflict dialog
    if (props.ytext.length > 0) {
      showConflict.value = true
    } else {
      applyImport('replace')
    }
  } catch (e: any) {
    error.value = e.data?.message || e.message || t('import.error')
  } finally {
    importing.value = false
  }
}

function applyImport(mode: 'replace' | 'append') {
  if (!importedMarkdown.value) return

  if (mode === 'replace') {
    props.ytext.delete(0, props.ytext.length)
    props.ytext.insert(0, importedMarkdown.value)
  } else {
    props.ytext.insert(props.ytext.length, '\n\n' + importedMarkdown.value)
  }

  showConflict.value = false
  importedMarkdown.value = ''
  selectedFile.value = null
  open.value = false
}

function cancelImport() {
  showConflict.value = false
  importedMarkdown.value = ''
}
</script>

<template>
  <UModal v-model:open="open" :title="t('import.title')">
    <template #content>
      <div class="p-6 space-y-4">
        <h3 class="text-lg font-semibold">{{ t('import.title') }}</h3>

        <!-- Conflict resolution -->
        <div v-if="showConflict" class="space-y-4">
          <div class="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
            <div class="flex items-start gap-2">
              <UIcon name="i-lucide-alert-triangle" class="size-5 text-amber-500 mt-0.5 shrink-0" />
              <div>
                <p class="text-sm font-medium">{{ t('import.conflictTitle') }}</p>
                <p class="text-sm text-muted mt-1">{{ t('import.conflictDesc') }}</p>
              </div>
            </div>
          </div>
          <div class="flex gap-2">
            <UButton
              class="flex-1"
              variant="solid"
              color="primary"
              @click="applyImport('replace')"
            >
              <UIcon name="i-lucide-replace" class="size-4 mr-1" />
              {{ t('import.replace') }}
            </UButton>
            <UButton
              class="flex-1"
              variant="outline"
              @click="applyImport('append')"
            >
              <UIcon name="i-lucide-plus" class="size-4 mr-1" />
              {{ t('import.append') }}
            </UButton>
            <UButton
              variant="ghost"
              @click="cancelImport"
            >
              {{ t('common.cancel') }}
            </UButton>
          </div>
        </div>

        <!-- File selection -->
        <div v-else>
          <p class="text-sm text-muted mb-3">{{ t('import.description') }}</p>

          <input
            ref="fileInput"
            type="file"
            :accept="ACCEPTED"
            class="hidden"
            @change="onFileChange"
          >

          <div
            :class="[
              'border-2 rounded-lg p-8 text-center cursor-pointer transition-colors',
              selectedFile
                ? 'border-solid border-primary bg-primary/5 hover:bg-primary/10'
                : 'border-dashed border-default hover:border-muted'
            ]"
            @click="selectFile"
          >
            <template v-if="selectedFile">
              <UIcon name="i-lucide-file-check-2" class="size-10 text-primary mx-auto mb-2" />
              <p class="text-sm font-medium break-all">{{ selectedFile.name }}</p>
              <p class="text-xs text-muted mt-1">{{ formatBytes(selectedFile.size) }}</p>
              <div class="flex items-center justify-center gap-3 mt-3 text-xs">
                <button
                  type="button"
                  class="text-primary hover:underline"
                  @click.stop="selectFile"
                >
                  {{ t('import.changeFile') }}
                </button>
                <span class="text-muted">·</span>
                <button
                  type="button"
                  class="text-muted hover:text-default"
                  @click="clearSelection"
                >
                  {{ t('common.cancel') }}
                </button>
              </div>
            </template>
            <template v-else>
              <UIcon name="i-lucide-file-up" class="size-10 text-muted mx-auto mb-2" />
              <p class="text-sm text-muted">{{ t('import.selectFile') }}</p>
              <p class="text-xs text-muted mt-1">{{ t('import.formats') }}</p>
            </template>
          </div>

          <p v-if="error" class="text-sm text-red-500 mt-2">{{ error }}</p>

          <div class="flex justify-end gap-2 mt-4">
            <UButton variant="ghost" @click="open = false">
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              :loading="importing"
              :disabled="!selectedFile"
              @click="doImport"
            >
              <UIcon name="i-lucide-file-input" class="size-4 mr-1" />
              {{ t('import.import') }}
            </UButton>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
