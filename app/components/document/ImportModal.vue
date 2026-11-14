<script setup lang="ts">
import type { Text as YText } from 'yjs'
import type { ImportedDocProperties } from '~~/shared/utils/markdown/markdownFrontmatter'
import { MIB } from '~~/shared/config/units'
import type { ApiResponse } from '~/utils/api/client'

const props = defineProps<{
  ytext: YText
  readOnly: boolean
  /** Sent with the file so a Markdown import can check the theme's images and custom CSS against this document. */
  docId: string
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  /** Validated theme + document properties from a markoto Markdown file's frontmatter. */
  'apply-properties': [properties: ImportedDocProperties, notes: { ignored: string[], droppedCustomCssRules: number }]
}>()

type ImportResponse = ApiResponse<'/api/import', 'post'>

const { t } = useI18n()
const { extractError } = useErrorHandler()

const selectedFile = ref<File | null>(null)
// Last import response (for the properties of a markoto Markdown file).
const importedResult = shallowRef<ImportResponse | null>(null)
const applyProperties = ref(true)
const docHasContent = ref(false)
const importedProperties = computed(() => {
  const p = importedResult.value?.properties
  return p && Object.keys(p).length > 0 ? p : null
})
const error = ref('')
const showConflict = ref(false)

const {
  state: importedMarkdown,
  isLoading: importing,
  execute: runImport
} = useAsyncState<string>(
  async () => {
    const file = selectedFile.value
    if (!file) return ''
    const formData = new FormData()
    formData.append('file', file)
    formData.append('docId', props.docId)
    const result = await apiFetch('/api/import', { method: 'post', body: formData })
    importedResult.value = result
    applyProperties.value = true
    return result.markdown
  },
  '',
  {
    immediate: false,
    resetOnExecute: false,
    onSuccess: (markdown) => {
      // If the document already has content, or the file brings a theme
      // + settings (the user decides whether to apply them), show the
      // second step; otherwise replace immediately.
      if (!markdown && !importedProperties.value) return
      docHasContent.value = props.ytext.length > 0
      if (docHasContent.value || importedProperties.value) showConflict.value = true
      else applyImport('replace')
    },
    onError: (e) => {
      error.value = extractError(e).message
    }
  }
)

const ACCEPTED = '.md,.markdown,.docx,.pdf,.pptx,.xlsx,.xls,.html,.htm,.epub'

// `reset: true` per `open()` so re-selecting the same file fires
// onChange again (native input dedupes identical paths otherwise).
const { open: selectFile, onChange: onFileChange, reset: resetFileDialog } = useFileDialog({
  accept: ACCEPTED,
  multiple: false,
  reset: true
})

onFileChange((files) => {
  selectedFile.value = files?.[0] ?? null
  error.value = ''
})

function clearSelection(e: Event) {
  // Stop propagation so the parent dropzone's click-to-pick doesn't fire
  // immediately after we cleared.
  e.stopPropagation()
  selectedFile.value = null
  error.value = ''
  resetFileDialog()
}

// Reset transient state whenever the modal closes, by cancel button,
// outside-click, or escape. Otherwise re-opening still shows the previous
// file selection, which reads as "your import is half-done" instead of
// the fresh state the user expects.
watch(open, (isOpen) => {
  if (!isOpen) {
    selectedFile.value = null
    error.value = ''
    importedMarkdown.value = ''
    importedResult.value = null
    showConflict.value = false
    resetFileDialog()
  }
})

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < MIB) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function doImport() {
  if (!selectedFile.value) return
  error.value = ''
  await runImport()
}

function applyImport(mode: 'replace' | 'append') {
  if (!importedMarkdown.value && !importedProperties.value) return

  if (!importedMarkdown.value) {
    // Settings only (a markoto file with an empty body): keep the text.
  } else if (mode === 'replace') {
    props.ytext.delete(0, props.ytext.length)
    props.ytext.insert(0, importedMarkdown.value)
  } else {
    props.ytext.insert(props.ytext.length, '\n\n' + importedMarkdown.value)
  }

  const properties = importedProperties.value
  if (properties && applyProperties.value) {
    emit('apply-properties', properties, {
      ignored: importedResult.value?.ignored ?? [],
      droppedCustomCssRules: importedResult.value?.droppedCustomCssRules ?? 0
    })
  }
  importedResult.value = null

  showConflict.value = false
  importedMarkdown.value = ''
  selectedFile.value = null
  open.value = false
}

function cancelImport() {
  showConflict.value = false
  importedMarkdown.value = ''
  importedResult.value = null
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('import.title')"
  >
    <template #content>
      <div class="p-6 space-y-4">
        <h3 class="text-lg font-semibold">
          {{ t('import.title') }}
        </h3>

        <div
          v-if="showConflict"
          class="space-y-4"
        >
          <div
            v-if="docHasContent"
            class="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30"
          >
            <div class="flex items-start gap-2">
              <UIcon
                name="i-lucide-alert-triangle"
                class="size-5 text-amber-500 mt-0.5 shrink-0"
              />
              <div>
                <p class="text-sm font-medium">
                  {{ t('import.conflictTitle') }}
                </p>
                <p class="text-sm text-muted mt-1">
                  {{ t('import.conflictDesc') }}
                </p>
              </div>
            </div>
          </div>
          <UCheckbox
            v-if="importedProperties"
            v-model="applyProperties"
            :label="t('import.applyProperties')"
            :description="t('import.applyPropertiesHelp')"
            data-testid="import-apply-properties"
          />
          <div
            v-if="!docHasContent"
            class="flex gap-2 justify-end"
          >
            <UButton
              variant="ghost"
              data-testid="import-conflict-cancel"
              @click="cancelImport"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              color="neutral"
              data-testid="import-apply"
              @click="applyImport('replace')"
            >
              {{ t('import.import') }}
            </UButton>
          </div>
          <div
            v-else
            class="flex gap-2"
          >
            <UButton
              class="flex-1"
              variant="solid"
              color="neutral"
              data-testid="import-replace-all"
              @click="applyImport('replace')"
            >
              <UIcon
                name="i-lucide-replace"
                class="size-4 mr-1"
              />
              {{ t('import.replace') }}
            </UButton>
            <UButton
              class="flex-1"
              variant="outline"
              data-testid="import-append"
              @click="applyImport('append')"
            >
              <UIcon
                name="i-lucide-plus"
                class="size-4 mr-1"
              />
              {{ t('import.append') }}
            </UButton>
            <UButton
              variant="ghost"
              data-testid="import-conflict-cancel"
              @click="cancelImport"
            >
              {{ t('common.cancel') }}
            </UButton>
          </div>
        </div>

        <div v-else>
          <p class="text-sm text-muted mb-3">
            {{ t('import.description') }}
          </p>

          <div
            role="presentation"
            :class="[
              'border-2 rounded-lg p-8 text-center cursor-pointer transition-colors',
              selectedFile
                ? 'border-solid border-primary bg-primary/5 hover:bg-primary/10'
                : 'border-dashed border-default hover:border-muted'
            ]"
            data-testid="import-dropzone"
            @click="selectFile()"
          >
            <template v-if="selectedFile">
              <UIcon
                name="i-lucide-file-check-2"
                class="size-10 text-primary mx-auto mb-2"
              />
              <p class="text-sm font-medium break-all">
                {{ selectedFile.name }}
              </p>
              <p class="text-xs text-muted mt-1">
                {{ formatBytes(selectedFile.size) }}
              </p>
              <div class="flex items-center justify-center gap-3 mt-3 text-xs">
                <button
                  type="button"
                  class="text-primary hover:underline"
                  @click.stop="selectFile()"
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
              <UIcon
                name="i-lucide-file-up"
                class="size-10 text-muted mx-auto mb-2"
              />
              <button
                type="button"
                class="text-sm text-muted"
                @click.stop="selectFile()"
              >
                {{ t('import.selectFile') }}
              </button>
              <p class="text-xs text-muted mt-1">
                {{ t('import.formats') }}
              </p>
            </template>
          </div>

          <p
            v-if="error"
            class="text-sm text-red-500 mt-2"
          >
            {{ error }}
          </p>

          <div class="flex justify-end gap-2 mt-4">
            <UButton
              variant="ghost"
              @click="open = false"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              :loading="importing"
              :disabled="!selectedFile"
              data-testid="import-submit"
              @click="doImport"
            >
              <UIcon
                name="i-lucide-file-input"
                class="size-4 mr-1"
              />
              {{ t('import.import') }}
            </UButton>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
