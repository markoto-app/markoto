<script setup lang="ts">
import type { ApiResponse } from '~/utils/api/client'
import { formatBytes } from '~/utils/billing/usageMeter'

// Profile → Your data: request a data export (GDPR Art.15/20) and download
// the ready ones. The list polls while a job is queued or running.
defineProps<{
  /** An account deletion is scheduled: no new export. */
  deletionPending: boolean
}>()
const { t, locale } = useI18n()
const toast = useToast()
const { handleReauthRequired, extractError } = useErrorHandler()
const { loggedIn } = useUserSession()

type ExportJob = ApiResponse<'/api/user/exports', 'get'>[number]

const exports = ref<ExportJob[]>([])
const exportsLoading = ref(false)
const requestingExport = ref(false)

async function refreshExports(): Promise<void> {
  if (!loggedIn.value) return
  exportsLoading.value = true
  try {
    exports.value = await apiFetch('/api/user/exports')
  } catch (e) {
    toast.add({
      title: t('settings.profile.data.loadFailed'),
      description: extractError(e).message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    exportsLoading.value = false
  }
}

onMounted(() => {
  void refreshExports()
})

const hasActiveExport = computed(() =>
  exports.value.some(j => j.status === 'queued' || j.status === 'running')
)

// Auto-poll while a job is in flight. Worker tick is 60s in prod;
// 5s polling means the user sees the row flip to ready within
// seconds of the worker completing. Email is the out-of-band channel
// for users who closed the tab; this covers everyone else. Interval
// is set on first transition into "active" and cleared the moment
// `hasActiveExport` flips back to false (or component unmounts).
let pollHandle: ReturnType<typeof setInterval> | null = null
function startPolling(): void {
  if (pollHandle !== null) return
  pollHandle = setInterval(() => {
    void refreshExports()
  }, 5000)
}
function stopPolling(): void {
  if (pollHandle === null) return
  clearInterval(pollHandle)
  pollHandle = null
}
watch(hasActiveExport, (active) => {
  if (active) startPolling()
  else stopPolling()
})
onBeforeUnmount(() => stopPolling())

async function onRequestExport(): Promise<void> {
  if (requestingExport.value) return
  requestingExport.value = true
  try {
    await apiFetch('/api/user/export', { method: 'post' })
    toast.add({
      title: t('settings.profile.data.exportInProgress'),
      description: '',
      icon: 'i-lucide-package',
      color: 'neutral'
    })
    await refreshExports()
  } catch (e) {
    if (handleReauthRequired(e)) return
    toast.add({
      title: t('settings.profile.data.requestFailed'),
      description: extractError(e).message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    requestingExport.value = false
  }
}

const fmtBytes = formatBytes
function fmtDate(iso: string | null): string {
  return formatDateTime(iso, locale.value)
}
</script>

<template>
  <section
    class="mb-10"
    data-testid="profile-data-section"
  >
    <h2 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-3">
      {{ t('settings.profile.data.heading') }}
    </h2>
    <div class="border border-default rounded-lg px-4 py-4">
      <p class="font-serif text-base font-normal mb-1">
        {{ t('settings.profile.data.exportTitle') }}
      </p>
      <p class="text-sm text-muted mb-4">
        {{ t('settings.profile.data.exportDescription') }}
      </p>
      <div class="flex items-center gap-3 mb-4">
        <UButton
          color="neutral"
          :loading="requestingExport"
          :disabled="hasActiveExport || deletionPending"
          icon="i-lucide-package"
          data-testid="export-request-button"
          @click="onRequestExport"
        >
          {{ t('settings.profile.data.exportButton') }}
        </UButton>
        <span
          v-if="hasActiveExport"
          class="text-xs text-muted font-mono"
        >
          {{ t('settings.profile.data.exportInProgress') }}
        </span>
      </div>

      <h3 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
        {{ t('settings.profile.data.exportHistoryHeading') }}
      </h3>
      <div
        v-if="exportsLoading"
        class="text-sm text-muted"
      >
        <UIcon
          name="i-lucide-loader-2"
          class="size-4 animate-spin inline mr-2"
        />
        {{ t('common.loading') }}
      </div>
      <div
        v-else-if="exports.length === 0"
        class="text-sm text-muted font-mono"
      >
        {{ t('settings.profile.data.exportHistoryEmpty') }}
      </div>
      <ul
        v-else
        class="space-y-2"
      >
        <li
          v-for="job in exports"
          :key="job.jobId"
          class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border border-default rounded-md px-3 py-3"
          data-testid="export-history-row"
        >
          <!-- Metadata stack. On mobile each fact lives on its
               own line with a tiny mono label so the user can
               tell "requested" from "available until", earlier
               the two dates ran together with no separator and
               were visually conflated. On desktop the layout
               compresses to one row. -->
          <div class="text-xs flex-1 min-w-0 space-y-0.5">
            <div class="flex items-center gap-2 flex-wrap">
              <span
                class="font-mono uppercase tracking-wider"
                :class="{
                  'text-rose-700 dark:text-rose-300': job.status === 'failed',
                  'text-muted': job.status !== 'failed' && job.status !== 'ready',
                  'text-default': job.status === 'ready'
                }"
              >
                {{ job.status }}
              </span>
              <span
                v-if="job.sizeBytes"
                class="font-mono text-muted"
              >
                {{ fmtBytes(job.sizeBytes) }}
              </span>
            </div>
            <div class="flex flex-col sm:flex-row sm:gap-3 text-muted font-mono">
              <span>
                <span class="uppercase tracking-wider">{{ t('settings.profile.data.exportRequested') }}</span>
                {{ fmtDate(job.createdAt) }}
              </span>
              <span v-if="job.expiresAt && job.status === 'ready'">
                <span class="uppercase tracking-wider">{{ t('settings.profile.data.exportAvailableUntil') }}</span>
                {{ fmtDate(job.expiresAt) }}
              </span>
            </div>
            <div
              v-if="job.errorMessage"
              class="text-rose-700 dark:text-rose-300 truncate"
            >
              {{ job.errorMessage }}
            </div>
          </div>
          <UButton
            v-if="job.downloadable"
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-download"
            block
            class="sm:!w-auto sm:!self-center shrink-0"
            :to="`/api/user/exports/${job.jobId}/download`"
            external
            data-testid="export-download-button"
          >
            {{ t('settings.profile.data.exportDownload') }}
          </UButton>
        </li>
      </ul>
    </div>
  </section>
</template>
