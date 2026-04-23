<script setup lang="ts">
// Knowledge base panel for the workspace page. Uploads go through the
// same presigned-PUT ceremony as document images: request-url → PUT bytes →
// confirm. Confirm kicks off the background processing pipeline
// (markitdown → chunk → embed); the UI polls for status transitions.
//
// Permissions mirror the server-side enforcement in
// `requireKnowledgeEditAccess`/`requireKnowledgeDeleteAccess`:
//   - viewers see the list but no upload/delete affordances
//   - editors can upload + delete their own rows
//   - admins can upload + delete anything

interface KnowledgeItem {
  knowledgeId: string
  filename: string
  sourceExt: string
  mimeType: string
  sizeBytes: number
  status: 'processing' | 'ready' | 'failed'
  errorMessage: string | null
  chunkCount: number
  tokenCount: number
  uploaderId: number | null
  createdAt: string | Date
  processedAt: string | Date | null
}

interface KnowledgeUsage {
  count: number
  totalBytes: number
  maxFiles: number
  maxBytes: number
  maxFileBytes: number
}

const props = defineProps<{
  workspaceId: string
  myRole: 'admin' | 'editor' | 'viewer'
  myUserId: number | null
  // When embedded inside a parent that already carries a heading (e.g.
  // the editor's right sidebar), drop our own title row and description
  // paragraph so they don't duplicate the surrounding chrome. The
  // Upload button folds up next to the count badge in that case.
  compact?: boolean
}>()

const { t } = useI18n()
const toast = useToast()

const items = ref<KnowledgeItem[]>([])
const usage = ref<KnowledgeUsage | null>(null)
const loading = ref(true)
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadProgress = ref<{ filename: string, percent: number } | null>(null)

const canEdit = computed(() => props.myRole === 'admin' || props.myRole === 'editor')

function canDelete(row: KnowledgeItem): boolean {
  if (props.myRole === 'admin') return true
  if (props.myRole === 'editor' && row.uploaderId != null && row.uploaderId === props.myUserId) return true
  return false
}

async function load() {
  loading.value = true
  try {
    const resp = await $fetch<{ items: KnowledgeItem[], usage: KnowledgeUsage }>(
      `/api/workspaces/${props.workspaceId}/knowledge`
    )
    items.value = resp.items
    usage.value = resp.usage
  } catch (e: any) {
    toast.add({
      title: t('knowledge.loadFailed'),
      description: e?.data?.message || e?.message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    loading.value = false
  }
}

watch(() => props.workspaceId, load, { immediate: true })

// Poll for status transitions when processing items exist. Cheap enough
// (one GET every 5s, only while items are in flight); stops automatically
// once all items reach a terminal state.
let pollTimer: ReturnType<typeof setInterval> | null = null
function ensurePolling() {
  const anyProcessing = items.value.some(it => it.status === 'processing')
  if (anyProcessing && !pollTimer) {
    pollTimer = setInterval(load, 5000)
  } else if (!anyProcessing && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
watch(items, ensurePolling, { deep: true })
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})

function pickFile() {
  fileInput.value?.click()
}

async function handleFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = '' // reset so the same file can be picked again after an error
  for (const file of files) {
    await uploadOne(file)
  }
  await load()
}

async function uploadOne(file: File) {
  if (!canEdit.value) return
  uploading.value = true
  uploadProgress.value = { filename: file.name, percent: 0 }
  try {
    const step1 = await $fetch<{
      knowledgeId: string
      uploadUrl: string
      s3Key: string
      ext: string
      mimeType: string
    }>(
      `/api/workspaces/${props.workspaceId}/knowledge/upload-request`,
      {
        method: 'POST',
        body: { filename: file.name, size: file.size }
      }
    )
    await putWithProgress(step1.uploadUrl, file, step1.mimeType, (p) => {
      uploadProgress.value = { filename: file.name, percent: p }
    })
    await $fetch(
      `/api/workspaces/${props.workspaceId}/knowledge/confirm`,
      {
        method: 'POST',
        body: {
          knowledgeId: step1.knowledgeId,
          s3Key: step1.s3Key,
          filename: file.name,
          ext: step1.ext,
          mimeType: step1.mimeType
        }
      }
    )
    toast.add({
      title: t('knowledge.uploadQueued'),
      description: file.name,
      icon: 'i-lucide-check',
      color: 'success'
    })
  } catch (e: any) {
    toast.add({
      title: t('knowledge.uploadFailed'),
      description: e?.data?.message || e?.message || String(e),
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    uploading.value = false
    uploadProgress.value = null
  }
}

// XHR not fetch — fetch's ReadableStream progress is supported but
// inconsistent across browsers, and the S3-compatible endpoint wants a
// simple PUT with Content-Type anyway.
function putWithProgress(url: string, file: File, contentType: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    })
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`S3 PUT failed: ${xhr.status} ${xhr.statusText}`))
    }
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.send(file)
  })
}

const deleteTarget = ref<KnowledgeItem | null>(null)
const showDeleteModal = ref(false)

function openDeleteModal(row: KnowledgeItem) {
  if (!canDelete(row)) return
  deleteTarget.value = row
  showDeleteModal.value = true
}

function onItemDeleted() {
  if (!deleteTarget.value) return
  items.value = items.value.filter(it => it.knowledgeId !== deleteTarget.value!.knowledgeId)
  deleteTarget.value = null
  // Re-fetch usage so the "X MB of Y MB" footer updates.
  void load()
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function statusColor(status: KnowledgeItem['status']): 'neutral' | 'warning' | 'success' | 'error' {
  switch (status) {
    case 'processing': return 'warning'
    case 'ready': return 'success'
    case 'failed': return 'error'
  }
}

function iconFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'pdf': return 'i-lucide-file-type'
    case 'docx': return 'i-lucide-file-text'
    case 'pptx': return 'i-lucide-file-presentation'
    case 'xlsx': case 'xls': return 'i-lucide-file-spreadsheet'
    case 'html': case 'htm': return 'i-lucide-file-code'
    case 'epub': return 'i-lucide-book-open'
    default: return 'i-lucide-file'
  }
}
</script>

<template>
  <section class="space-y-3">
    <!-- Full header (title + description). Hidden in compact mode when
         the embedding surface already provides its own title. -->
    <div
      v-if="!compact"
      class="flex items-center justify-between gap-3 flex-wrap"
    >
      <div class="flex items-center gap-2 min-w-0">
        <UIcon
          name="i-lucide-library"
          class="text-primary size-5 shrink-0"
        />
        <h2 class="text-lg font-semibold">
          {{ t('knowledge.title') }}
        </h2>
        <UBadge
          v-if="usage"
          size="xs"
          color="neutral"
          variant="subtle"
        >
          {{ usage.count }} / {{ usage.maxFiles }}
        </UBadge>
      </div>
      <UButton
        v-if="canEdit"
        icon="i-lucide-upload"
        size="sm"
        :loading="uploading"
        @click="pickFile"
      >
        {{ t('knowledge.upload') }}
      </UButton>
    </div>
    <p
      v-if="!compact"
      class="text-xs text-muted"
    >
      {{ t('knowledge.description') }}
    </p>
    <!-- Compact header: badge + upload button on one line, no section
         title (the parent provides it). -->
    <div
      v-else
      class="flex items-center justify-between gap-2"
    >
      <UBadge
        v-if="usage"
        size="xs"
        color="neutral"
        variant="subtle"
      >
        {{ usage.count }} / {{ usage.maxFiles }}
      </UBadge>
      <UButton
        v-if="canEdit"
        icon="i-lucide-upload"
        size="xs"
        :loading="uploading"
        @click="pickFile"
      >
        {{ t('knowledge.upload') }}
      </UButton>
    </div>

    <input
      ref="fileInput"
      type="file"
      class="hidden"
      accept=".pdf,.docx,.pptx,.xlsx,.xls,.html,.htm,.epub,.md,.txt"
      multiple
      @change="handleFiles"
    >

    <div
      v-if="uploadProgress"
      class="flex items-center gap-3 p-3 rounded-lg border border-default bg-muted/40"
    >
      <UIcon
        name="i-lucide-upload"
        class="size-4 text-muted"
      />
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium truncate">{{ uploadProgress.filename }}</p>
        <div class="mt-1 h-1.5 rounded-full bg-default overflow-hidden">
          <div
            class="h-full bg-primary transition-all"
            :style="{ width: `${uploadProgress.percent}%` }"
          />
        </div>
      </div>
      <span class="text-xs text-muted">{{ uploadProgress.percent }}%</span>
    </div>

    <div
      v-if="loading && items.length === 0"
      class="flex justify-center py-6"
    >
      <UIcon
        name="i-lucide-loader"
        class="size-5 animate-spin text-muted"
      />
    </div>

    <div
      v-else-if="items.length === 0"
      class="text-center py-8 border border-dashed border-default rounded-lg"
    >
      <UIcon
        name="i-lucide-upload-cloud"
        class="size-6 text-muted mx-auto mb-2"
      />
      <p class="text-sm font-medium">
        {{ t('knowledge.empty') }}
      </p>
      <p class="text-xs text-muted mt-1">
        {{ canEdit ? t('knowledge.emptyDescription') : t('knowledge.emptyDescriptionViewer') }}
      </p>
    </div>

    <div
      v-else
      class="space-y-2"
    >
      <div
        v-for="row in items"
        :key="row.knowledgeId"
        class="group flex items-center gap-3 p-3 rounded-lg border border-default hover:bg-muted/50 transition-colors"
      >
        <UIcon
          :name="iconFor(row.sourceExt)"
          class="size-5 text-muted shrink-0"
        />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium truncate">{{ row.filename }}</p>
          <p class="text-xs text-muted">
            {{ fmtBytes(row.sizeBytes) }}
            <template v-if="row.status === 'ready'">
              · {{ row.chunkCount }} {{ t('knowledge.chunks') }}
            </template>
            <template v-if="row.status === 'failed' && row.errorMessage">
              · {{ row.errorMessage }}
            </template>
          </p>
        </div>
        <UBadge
          :color="statusColor(row.status)"
          variant="subtle"
          size="xs"
        >
          <template v-if="row.status === 'processing'">
            <UIcon
              name="i-lucide-loader"
              class="size-3 animate-spin mr-1"
            />
            {{ t('knowledge.status.processing') }}
          </template>
          <template v-else-if="row.status === 'ready'">
            {{ t('knowledge.status.ready') }}
          </template>
          <template v-else>
            {{ t('knowledge.status.failed') }}
          </template>
        </UBadge>
        <UButton
          v-if="canDelete(row)"
          icon="i-lucide-trash-2"
          color="neutral"
          variant="ghost"
          size="xs"
          class="opacity-60 group-hover:opacity-100 transition-opacity"
          @click="openDeleteModal(row)"
        />
      </div>
    </div>

    <p
      v-if="usage && usage.totalBytes > 0"
      class="text-xs text-muted pt-1"
    >
      {{ fmtBytes(usage.totalBytes) }} / {{ fmtBytes(usage.maxBytes) }}
    </p>

    <WorkspaceKnowledgeDeleteConfirmModal
      v-if="deleteTarget"
      v-model:open="showDeleteModal"
      :workspace-id="workspaceId"
      :knowledge-id="deleteTarget.knowledgeId"
      :filename="deleteTarget.filename"
      @deleted="onItemDeleted"
    />
  </section>
</template>
