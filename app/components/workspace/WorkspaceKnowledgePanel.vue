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

const usage = ref<KnowledgeUsage | null>(null)
const uploading = ref(false)
const uploadProgress = ref<{ filename: string, percent: number } | null>(null)

const {
  state: items,
  isLoading: loading,
  execute: load
} = useAsyncState<KnowledgeItem[]>(
  async () => {
    const resp = await $fetch<{ items: KnowledgeItem[], usage: KnowledgeUsage }>(
      `/api/workspaces/${props.workspaceId}/knowledge`
    )
    usage.value = resp.usage
    return resp.items
  },
  [],
  {
    immediate: false,
    resetOnExecute: false,
    onError: (e: { data?: { message?: string }, message?: string } | unknown) => {
      const err = e as { data?: { message?: string }, message?: string }
      toast.add({
        title: t('knowledge.loadFailed'),
        description: err?.data?.message || err?.message,
        icon: 'i-lucide-alert-circle',
        color: 'error'
      })
    }
  }
)

const canEdit = computed(() => props.myRole === 'admin' || props.myRole === 'editor')

// Cap pre-enforcement. The upload-request endpoint enforces the same
// caps server-side (409) but we mirror them here so the upload button
// disables BEFORE the click, not after. Two axes: file count, total
// bytes. `usage.maxFiles` / `usage.maxBytes` are per-workspace, tier-
// resolved on the server (AI-workspace uses the sponsor's caps).
// Per-user caps are ALSO enforced server-side but aren't surfaced
// here — if a user tops out their per-user bytes in another
// workspace, they'd click here and see a 409 toast. Acceptable
// corner case: per-user caps require a dedicated endpoint to surface
// cleanly, and this is the less common cap to hit.
const router = useRouter()
const filesCapReached = computed(() => !!usage.value && usage.value.count >= usage.value.maxFiles)
const bytesCapReached = computed(() => !!usage.value && usage.value.totalBytes >= usage.value.maxBytes)
const uploadCapReached = computed(() => filesCapReached.value || bytesCapReached.value)
// Billing mode decides what the at-cap affordance says and where it
// goes: billing on → "upgrade" + /pricing; hosted free-only SaaS →
// "paid plans coming soon" + /pricing (coming-soon page); self-hosted →
// just "limit reached" and a toast, never a dead purchase link.
const { billingEnabled, plansComingSoon, pricingVisible } = useBillingMode()
const uploadCapTooltip = computed(() => {
  const limitMb = Math.round((usage.value?.maxBytes ?? 0) / (1024 * 1024))
  let msg = ''
  if (filesCapReached.value) {
    msg = billingEnabled.value
      ? t('knowledge.capFilesReached', { limit: usage.value?.maxFiles ?? 0 })
      : t('knowledge.capFilesReachedFree', { limit: usage.value?.maxFiles ?? 0 })
  } else if (bytesCapReached.value) {
    msg = billingEnabled.value
      ? t('knowledge.capBytesReached', { limit: limitMb })
      : t('knowledge.capBytesReachedFree', { limit: limitMb })
  }
  if (msg && plansComingSoon.value) msg = `${msg} ${t('billing.comingSoonHint')}`
  return msg
})
const uploadCapShortLabel = computed(() =>
  billingEnabled.value ? t('knowledge.capReachedShort') : t('knowledge.capReachedShortFree')
)
function onUploadClick() {
  if (uploadCapReached.value) {
    if (pricingVisible.value) {
      router.push('/pricing')
    } else {
      toast.add({ title: uploadCapShortLabel.value, description: uploadCapTooltip.value, icon: 'i-lucide-lock', color: 'neutral' })
    }
    return
  }
  pickFile()
}

function canDelete(row: KnowledgeItem): boolean {
  if (props.myRole === 'admin') return true
  if (props.myRole === 'editor' && row.uploaderId != null && row.uploaderId === props.myUserId) return true
  return false
}

watch(() => props.workspaceId, () => load(), { immediate: true })

// Poll for status transitions when processing items exist. Cheap enough
// (one GET every 5s, only while items are in flight); stops automatically
// once all items reach a terminal state. Also pauses while the tab is
// hidden — `useIntervalFn` cleans up on unmount, no manual onBeforeUnmount.
const visibility = useDocumentVisibility()
const anyProcessing = computed(() => items.value.some(it => it.status === 'processing'))
const shouldPoll = computed(() => anyProcessing.value && visibility.value === 'visible')
const { pause, resume } = useIntervalFn(() => load(), 5000, { immediate: false })
watch(shouldPoll, (active) => {
  if (active) {
    // Catch up on the transition (any state-change that happened while
    // we were paused) before resuming the cadence.
    load()
    resume()
  } else {
    pause()
  }
})

// `reset: true` so re-picking the same file after a failure re-fires
// onChange (native input dedupes identical paths otherwise).
const { open: pickFile, onChange: onFilesPicked } = useFileDialog({
  accept: '.pdf,.docx,.pptx,.xlsx,.xls,.html,.htm,.epub,.md,.txt',
  multiple: true,
  reset: true
})

onFilesPicked(async (fileList) => {
  const files = Array.from(fileList ?? [])
  for (const file of files) {
    await uploadOne(file)
  }
  await load()
})

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
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: t('knowledge.uploadFailed'),
      description: err?.data?.message || err?.message || String(e),
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
      <!-- Knowledge-base title — Fraunces editorial register, matching
           workspace name + sidebar panel titles. The lucide icon
           drops to the toned neutral ramp (was shu, which clashed
           with the seal-only rule). The usage chip shifts to the
           editor's mono micro-meta voice for one consistent slate. -->
      <div class="flex items-center gap-2.5 min-w-0">
        <UIcon
          name="i-lucide-library"
          class="text-toned size-5 shrink-0"
        />
        <h2 class="font-serif text-2xl font-normal tracking-tight">
          {{ t('knowledge.title') }}
        </h2>
        <span
          v-if="usage"
          class="font-mono text-[10.5px] tracking-[0.04em] text-muted"
        >{{ usage.count }} <span class="opacity-50">/</span> {{ usage.maxFiles }}</span>
      </div>
      <UButton
        v-if="canEdit"
        :icon="uploadCapReached ? 'i-lucide-lock' : 'i-lucide-upload'"
        size="sm"
        :loading="uploading"
        :variant="uploadCapReached ? 'ghost' : 'solid'"
        color="neutral"
        :class="uploadCapReached ? 'opacity-60' : ''"
        :title="uploadCapReached ? uploadCapTooltip : undefined"
        data-testid="knowledge-upload-button"
        @click="onUploadClick"
      >
        {{ uploadCapReached ? uploadCapShortLabel : t('knowledge.upload') }}
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
        :icon="uploadCapReached ? 'i-lucide-lock' : 'i-lucide-upload'"
        size="xs"
        :loading="uploading"
        :variant="uploadCapReached ? 'ghost' : 'solid'"
        color="neutral"
        :class="uploadCapReached ? 'opacity-60' : ''"
        :title="uploadCapReached ? uploadCapTooltip : undefined"
        data-testid="knowledge-upload-button"
        @click="onUploadClick"
      >
        {{ uploadCapReached ? uploadCapShortLabel : t('knowledge.upload') }}
      </UButton>
    </div>

    <div
      v-if="uploadProgress"
      class="flex items-center gap-3 p-3 rounded-lg border border-default bg-muted/40"
    >
      <UIcon
        name="i-lucide-upload"
        class="size-4 text-muted"
      />
      <div class="flex-1 min-w-0">
        <!-- Filename in the editorial register — Fraunces serif so a
             knowledge file reads as a "named object" the same way a
             doc title or workspace name does. -->
        <p class="font-serif text-base font-normal tracking-tight truncate">
          {{ uploadProgress.filename }}
        </p>
        <div class="mt-1 h-1 rounded-full bg-elevated overflow-hidden">
          <!-- Progress fill stays neutral (sumi-700) — shu is reserved
               for AI presence; uploads aren't AI work. -->
          <div
            class="h-full bg-sumi-700 dark:bg-sumi-300 transition-all"
            :style="{ width: `${uploadProgress.percent}%` }"
          />
        </div>
      </div>
      <span class="font-mono text-[10.5px] tracking-[0.04em] text-muted">{{ uploadProgress.percent }}%</span>
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
      <p class="font-serif text-lg font-normal tracking-tight">
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
      <!-- Per-file row. Filename in Fraunces editorial register; size
           and chunk count in JetBrains Mono micro-meta — same colophon
           voice as the editor's status bar and comment timestamps. -->
      <div
        v-for="row in items"
        :key="row.knowledgeId"
        class="group flex items-center gap-3 p-3 rounded-lg border border-default bg-default hover:bg-elevated/40 transition-colors"
        :data-testid="`knowledge-file-row-${row.knowledgeId}`"
        :data-status="row.status"
        :data-filename="row.filename"
      >
        <UIcon
          :name="iconFor(row.sourceExt)"
          class="size-5 text-muted shrink-0"
        />
        <div class="min-w-0 flex-1">
          <p class="font-serif text-base font-normal tracking-tight truncate">
            {{ row.filename }}
          </p>
          <p class="font-mono text-[10.5px] tracking-[0.04em] text-muted lowercase mt-0.5">
            {{ fmtBytes(row.sizeBytes) }}
            <template v-if="row.status === 'ready'">
              <span
                class="opacity-50 mx-1"
                aria-hidden="true"
              >·</span> {{ row.chunkCount }} {{ t('knowledge.chunks') }}
            </template>
            <template v-if="row.status === 'failed' && row.errorMessage">
              <span
                class="opacity-50 mx-1"
                aria-hidden="true"
              >·</span> {{ row.errorMessage }}
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
