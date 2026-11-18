<script setup lang="ts">
import { useAiJobs, type UseAiJobsOptions } from '~/composables/ai/useAiJobs'

// Progress of my delegated AI job on this document (a translation, a tone
// change over many sections), above the prompt bar: done / total, the
// heading being worked on and Cancel (no cost: the only unit users see is
// AI points, on the plan and usage pages); afterwards a short
// report with "Undo job". Private to the person who started the job (the
// job routes answer 404 to anyone else). Survives a reload: the jobs are
// fetched on mount.

const props = defineProps<{
  docId: string
  /** My jobs present on the document right now (awareness), to notice a new one. */
  myJobIds: readonly string[]
  /** Test seam for the progress stream. */
  jobOptions?: UseAiJobsOptions
}>()

const { t } = useI18n()
const { current, notes, busy, error, undone, cancel, resume, undo, dismiss } = useAiJobs(() => props.docId, () => props.myJobIds, props.jobOptions)

const job = computed(() => current.value)
const running = computed(() => job.value?.status === 'running')
/** Every part is through but the job has not reported its end yet (final checks): no Cancel any more. */
const finishing = computed(() => {
  const j = job.value
  return !!j && running.value && j.total > 0 && j.done + j.skipped >= j.total
})
const percent = computed(() => {
  const j = job.value
  if (!j || j.total === 0) return 0
  return Math.min(100, Math.round(((j.done + j.skipped) / j.total) * 100))
})

const title = computed(() => {
  const j = job.value
  if (!j) return ''
  return t(`ai.job.modes.${j.mode}`)
})

const summary = computed(() => {
  const j = job.value
  if (!j) return ''
  switch (j.status) {
    case 'running': return finishing.value ? t('ai.job.finishing', { total: j.total }) : t('ai.job.progress', { done: j.done + j.skipped, total: j.total })
    case 'done': return t('ai.job.done', { done: j.done, total: j.total })
    case 'cancelled': return t('ai.job.cancelled', { done: j.done, total: j.total })
    case 'paused_budget': return t('ai.job.paused')
    case 'interrupted': return t('ai.job.interrupted')
    case 'reverted': return t('ai.job.reverted')
    case 'failed':
    case 'stopped_access':
    case 'preview':
    case 'awaiting_confirmation':
    default: return t('ai.job.failed', { reason: j.reason ?? '' })
  }
})

/** The result of my "Undo job" on this job, if I just clicked it. */
const undoReport = computed(() => {
  const j = job.value
  const u = undone.value
  return j && u && u.jobId === j.jobId ? u : null
})

const canResume = computed(() => ['cancelled', 'paused_budget', 'interrupted'].includes(job.value?.status ?? ''))
const canUndo = computed(() => {
  const j = job.value
  return !!j && !undoReport.value && j.mode !== 'comment' && j.done > 0 && ['done', 'cancelled', 'paused_budget', 'interrupted', 'failed', 'stopped_access'].includes(j.status)
})
const leftOut = computed(() => notes.value.filter(n => n.status !== 'flagged').length)
const flagged = computed(() => notes.value.filter(n => n.status === 'flagged').length)

const HEADINGS_SHOWN = 4

function headingList(paths: readonly string[]): string {
  const shown = paths.slice(0, HEADINGS_SHOWN).join(', ')
  return paths.length > HEADINGS_SHOWN ? `${shown}, …` : shown
}

/**
 * What undo did, in full sentences: restored parts (with the AI session's
 * later corrections), then each group of parts it kept and why. Replaces
 * the job's skipped / flagged note, which describes the job, not the undo.
 */
const undoLines = computed(() => {
  const u = undoReport.value
  if (!u) return []
  const lines = [u.reverted > 0 ? t('ai.job.undone', { count: u.reverted }, u.reverted) : t('ai.job.undoneNothing')]
  if (u.followUps > 0) lines.push(t('ai.job.undoneFollowUps', { count: u.followUps }, u.followUps))
  for (const kind of ['edited', 'deleted', 'expired'] as const) {
    const paths = u.kept.filter(k => k.kind === kind).map(k => k.headingPath)
    if (paths.length === 0) continue
    const key = kind === 'edited' ? 'ai.job.keptEdited' : kind === 'deleted' ? 'ai.job.keptDeleted' : 'ai.job.keptExpired'
    lines.push(t(key, { count: paths.length, headings: headingList(paths) }, paths.length))
  }
  return lines
})
const showJobNotes = computed(() => !running.value && !undoReport.value && job.value?.status !== 'reverted' && (leftOut.value > 0 || flagged.value > 0))
</script>

<template>
  <section
    v-if="job"
    class="ai-job-panel pointer-events-auto mb-2 block w-full max-w-3xl rounded-2xl border border-default bg-default px-4 py-3"
    role="status"
    aria-live="polite"
    data-testid="ai-job-panel"
    :data-job-id="job.jobId"
    :data-job-status="job.status"
  >
    <div class="flex items-start gap-3">
      <UIcon
        name="i-lucide-layers"
        class="mt-0.5 size-4 shrink-0 text-primary"
        :class="running ? 'animate-pulse' : ''"
      />
      <div class="min-w-0 flex-1">
        <div class="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
          {{ t('ai.job.label') }} · {{ title }}
        </div>
        <p
          v-if="undoLines.length === 0"
          class="mt-0.5 text-sm text-default"
          data-testid="ai-job-summary"
        >
          {{ summary }}
        </p>
        <div
          v-else
          data-testid="ai-job-undo-report"
        >
          <p
            class="mt-0.5 text-sm text-default"
            data-testid="ai-job-summary"
          >
            {{ undoLines[0] }}
          </p>
          <p
            v-for="(line, i) in undoLines.slice(1)"
            :key="i"
            class="mt-1 text-xs text-muted"
          >
            {{ line }}
          </p>
        </div>
        <div
          v-if="running"
          class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-elevated"
          role="progressbar"
          :aria-valuenow="percent"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div
            class="h-full rounded-full bg-primary transition-[width] duration-500"
            :style="{ width: `${percent}%` }"
          />
        </div>
        <p
          v-if="running && job.currentHeading"
          class="mt-1 truncate text-xs text-muted"
          data-testid="ai-job-heading"
        >
          {{ t('ai.job.working', { heading: job.currentHeading }) }}
        </p>
        <p
          v-if="showJobNotes"
          class="mt-1 text-xs text-muted"
        >
          <span v-if="leftOut > 0">{{ t('ai.job.skipped', { count: leftOut }) }}</span>
          <span v-if="flagged > 0"> {{ t('ai.job.flagged', { count: flagged }) }}</span>
        </p>
        <p
          v-if="error"
          class="mt-1 text-xs text-error"
        >
          {{ error }}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <UButton
          v-if="running && !finishing"
          color="neutral"
          variant="ghost"
          size="sm"
          :loading="busy"
          data-testid="ai-job-cancel"
          @click="cancel(job.jobId)"
        >
          {{ t('ai.job.cancel') }}
        </UButton>
        <UButton
          v-if="canResume"
          color="neutral"
          variant="ghost"
          size="sm"
          :disabled="busy"
          data-testid="ai-job-resume"
          @click="resume(job.jobId)"
        >
          {{ t('ai.job.resume') }}
        </UButton>
        <UButton
          v-if="canUndo"
          color="neutral"
          variant="ghost"
          size="sm"
          :loading="busy"
          data-testid="ai-job-undo"
          @click="undo(job.jobId)"
        >
          {{ t('ai.job.undo') }}
        </UButton>
        <UButton
          v-if="!running"
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-x"
          :aria-label="t('ai.job.dismiss')"
          data-testid="ai-job-dismiss"
          @click="dismiss(job.jobId)"
        />
      </div>
    </div>
  </section>
</template>
