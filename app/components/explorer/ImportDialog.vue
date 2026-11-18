<script setup lang="ts">
import type { ExplorerScope } from '~/composables/explorer/useExplorerData'
import { pickedFiles, type PickedFile } from '~/utils/explorer/droppedFiles'
import { classifyImportFile } from '~~/shared/config/imports'
import { isIgnoredImportPath } from '~~/shared/utils/documents/importPaths'
import { apiErrorData } from '~/utils/api/errors'

// Bulk import into a folder: files, a whole folder (its structure kept), zip
// archives, or a public GitHub repository / folder link. The dialog shows
// what will be imported and what is skipped before anything is uploaded,
// then uploads each file straight to storage, starts the job and follows its
// progress (it can be cancelled; documents already created stay). The import
// runs on the server, so the dialog may be closed meanwhile.

const props = defineProps<{
  scope: ExplorerScope
  folderId: string | null
  folderName: string
  initialFiles: readonly PickedFile[]
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ finished: [] }>()

const { t } = useI18n()
const { showError } = useErrorHandler()

const tab = ref<'files' | 'github'>('files')
const files = shallowRef<PickedFile[]>([])
const githubUrl = ref('')
type Phase = 'pick' | 'uploading' | 'running' | 'done'
const phase = ref<Phase>('pick')
const uploaded = ref(0)
const jobId = ref<string | null>(null)
type JobView = { status: string, total: number, done: number, failed: number, skipped: number, error: string | null }
const job = ref<JobView | null>(null)
const problems = ref<Array<{ path: string, status: string, reason: string | null }>>([])

watch(open, (v) => {
  if (!v) return
  if (phase.value === 'done' || phase.value === 'pick') {
    phase.value = 'pick'
    files.value = [...props.initialFiles]
    tab.value = 'files'
    jobId.value = null
    job.value = null
    problems.value = []
  }
}, { immediate: true })

const summary = computed(() => {
  let docs = 0
  let images = 0
  let archives = 0
  let skipped = 0
  let bytes = 0
  for (const f of files.value) {
    const cls = classifyImportFile(f.path)
    if (cls === 'other' || isIgnoredImportPath(f.path)) skipped++
    else {
      bytes += f.file.size
      if (cls === 'image') images++
      else if (cls === 'archive') archives++
      else docs++
    }
  }
  return { docs, images, archives, skipped, bytes }
})

const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
const folderInput = useTemplateRef<HTMLInputElement>('folderInput')
function onPicked(e: Event) {
  files.value = [...files.value, ...pickedFiles((e.target as HTMLInputElement).files)]
  ;(e.target as HTMLInputElement).value = ''
}

const target = computed(() => ({
  workspaceId: props.scope.kind === 'workspace' ? props.scope.workspaceId : null,
  folderId: props.folderId
}))

async function upload(url: string, file: File) {
  const res = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/octet-stream' } })
  if (!res.ok) throw new Error(`upload failed: ${res.status}`)
}

async function start() {
  try {
    if (tab.value === 'github') {
      const res = await apiFetch('/api/imports', { method: 'post', body: { source: 'github', ...target.value, url: githubUrl.value } })
      jobId.value = res.jobId
      phase.value = 'running'
      void poll()
      return
    }
    const byPath = new Map(files.value.map(f => [f.path, f.file]))
    const res = await apiFetch('/api/imports', {
      method: 'post',
      body: { source: 'upload', ...target.value, files: files.value.map(f => ({ path: f.path, size: f.file.size })) }
    })
    jobId.value = res.jobId
    phase.value = 'uploading'
    uploaded.value = 0
    // Four uploads at a time; one failed upload is reported by the worker as "not uploaded".
    const queue = [...res.uploads]
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const file = byPath.get(next.path) ?? files.value.find(f => f.path.toLowerCase() === next.path.toLowerCase())?.file
        if (file) await upload(next.url, file).catch(() => {})
        uploaded.value++
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
    await apiFetch('/api/imports/:jobId/start', { method: 'post', path: { jobId: res.jobId } })
    phase.value = 'running'
    void poll()
  } catch (e) {
    phase.value = 'pick'
    const code = apiErrorData(e)?.code
    showError(code === 'import/job-active' ? 'explorer.import.activeJob' : 'explorer.import.failed', e)
  }
}

const uploadTotal = computed(() => summary.value.docs + summary.value.images + summary.value.archives)

async function poll() {
  // Quick at first (small imports finish in a second or two), then calmer.
  let wait = 400
  while (jobId.value && (phase.value === 'running')) {
    try {
      const res = await apiFetch('/api/imports/:jobId', { path: { jobId: jobId.value } })
      job.value = res.job
      problems.value = res.problems
      if (['done', 'failed', 'cancelled'].includes(res.job.status)) {
        phase.value = 'done'
        emit('finished')
        return
      }
    } catch { /* keep polling */ }
    await new Promise(r => setTimeout(r, wait))
    wait = Math.min(1500, wait + 200)
  }
}

async function cancel() {
  if (!jobId.value) return
  await apiFetch('/api/imports/:jobId/cancel', { method: 'post', path: { jobId: jobId.value } }).catch(() => {})
}

const progress = computed(() => {
  if (phase.value === 'uploading') return uploadTotal.value === 0 ? 0 : Math.round(uploaded.value / uploadTotal.value * 100)
  const j = job.value
  if (!j || j.total === 0) return null
  return Math.round((j.done + j.failed) / j.total * 100)
})

function formatBytes(n: number) {
  return n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('explorer.import.title', { name: folderName })"
  >
    <template #body>
      <div
        class="space-y-4 text-sm"
        data-testid="explorer-import-dialog"
      >
        <template v-if="phase === 'pick'">
          <UTabs
            v-model="tab"
            :items="[{ label: t('explorer.import.fromFiles'), value: 'files' }, { label: t('explorer.import.fromGithub'), value: 'github' }]"
            :content="false"
            size="sm"
            color="neutral"
            variant="link"
          />
          <div
            v-if="tab === 'files'"
            class="space-y-3"
          >
            <p class="text-muted">
              {{ t('explorer.import.filesHint') }}
            </p>
            <div class="flex gap-2 flex-wrap">
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-files"
                @click="fileInput?.click()"
              >
                {{ t('explorer.import.chooseFiles') }}
              </UButton>
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-folder-up"
                @click="folderInput?.click()"
              >
                {{ t('explorer.import.chooseFolder') }}
              </UButton>
              <input
                ref="fileInput"
                type="file"
                multiple
                class="hidden"
                :aria-label="t('explorer.import.chooseFiles')"
                data-testid="explorer-import-files"
                @change="onPicked"
              >
              <input
                ref="folderInput"
                type="file"
                webkitdirectory
                class="hidden"
                :aria-label="t('explorer.import.chooseFolder')"
                data-testid="explorer-import-folder"
                @change="onPicked"
              >
            </div>
            <div
              v-if="files.length > 0"
              class="rounded-md bg-muted p-3 space-y-1"
              data-testid="explorer-import-summary"
            >
              <p>{{ t('explorer.import.summary', { docs: summary.docs, images: summary.images, archives: summary.archives }) }} · {{ formatBytes(summary.bytes) }}</p>
              <p
                v-if="summary.skipped > 0"
                class="text-muted"
              >
                {{ t('explorer.import.skippedFiles', { n: summary.skipped }, summary.skipped) }}
              </p>
            </div>
          </div>
          <div
            v-else
            class="space-y-2"
          >
            <UInput
              v-model="githubUrl"
              color="neutral"
              class="w-full"
              placeholder="https://github.com/owner/repository/tree/main/docs"
              :aria-label="t('explorer.import.githubLabel')"
              data-testid="explorer-import-github-url"
              @keydown.enter.prevent="githubUrl.trim() !== '' && start()"
            />
            <p class="text-muted text-xs">
              {{ t('explorer.import.githubHint') }}
            </p>
          </div>
        </template>

        <template v-else>
          <p v-if="phase === 'uploading'">
            {{ t('explorer.import.uploading', { done: uploaded, total: uploadTotal }) }}
          </p>
          <p
            v-else-if="job && !(phase === 'done' && job.total === 0)"
            data-testid="explorer-import-progress"
          >
            {{ t('explorer.import.progress', { done: job.done, failed: job.failed, total: job.total }) }}
          </p>
          <!-- A job that failed before it listed any file has no progress to show. -->
          <UProgress
            v-if="!(phase === 'done' && (job?.total ?? 0) === 0)"
            :model-value="progress"
            size="sm"
            color="neutral"
          />
          <template v-if="phase === 'done' && job">
            <UAlert
              :color="job.status === 'done' && job.failed === 0 ? 'success' : 'neutral'"
              variant="subtle"
              :title="t(`explorer.import.status.${job.status}`)"
              :description="job.error ? t(`explorer.import.jobError.${job.error}`) : undefined"
              data-testid="explorer-import-result"
            />
            <ul
              v-if="problems.length > 0"
              class="max-h-48 overflow-y-auto text-xs space-y-0.5"
            >
              <li
                v-for="p in problems"
                :key="p.path"
                class="flex gap-2"
              >
                <span class="truncate flex-1 font-mono">{{ p.path }}</span>
                <span class="text-muted shrink-0">{{ p.reason ? t(`explorer.import.reason.${p.reason}`) : t('explorer.import.reason.unused') }}</span>
              </li>
            </ul>
          </template>
          <p
            v-else
            class="text-xs text-muted"
          >
            {{ t('explorer.import.background') }}
          </p>
        </template>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          v-if="phase === 'running' || phase === 'uploading'"
          color="neutral"
          variant="ghost"
          data-testid="explorer-import-cancel"
          @click="cancel"
        >
          {{ t('explorer.import.cancel') }}
        </UButton>
        <UButton
          color="neutral"
          variant="ghost"
          @click="open = false"
        >
          {{ phase === 'pick' ? t('common.cancel') : t('common.close') }}
        </UButton>
        <UButton
          v-if="phase === 'pick'"
          color="neutral"
          :disabled="tab === 'files' ? uploadTotal === 0 : githubUrl.trim() === ''"
          data-testid="explorer-import-start"
          @click="start"
        >
          {{ t('explorer.import.start') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
