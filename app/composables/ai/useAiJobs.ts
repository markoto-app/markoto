import { onScopeDispose } from 'vue'
import type { ApiResponse } from '~/utils/api/client'
import type { AiEventSource } from '~/types/ai/session'

/** A delegated job as the job routes return it. */
export type AiJobView = ApiResponse<'/api/docs/:docId/ai-jobs', 'get'>['jobs'][number]
export type AiJobNote = ApiResponse<'/api/docs/:docId/ai-jobs/:jobId', 'get'>['notes'][number]

const ACTIVE = new Set(['preview', 'awaiting_confirmation', 'running'])
/** Statuses the prompt bar keeps showing until dismissed. */
const SHOWN = new Set(['running', 'paused_budget', 'interrupted', 'done', 'failed', 'cancelled', 'stopped_access', 'reverted'])
const POLL_MS = 3_000
/** A finished job older than this is not brought back after a reload. */
const RECENT_MS = 30 * 60_000

export interface UseAiJobsOptions {
  /** Test seam: builds the EventSource (null = no streaming, poll only). */
  createEventSource?: ((url: string) => AiEventSource) | null
  pollMs?: number
}

function defaultEventSourceFactory(): ((url: string) => AiEventSource) | null {
  if (typeof EventSource === 'undefined') return null
  return url => new EventSource(url)
}

/**
 * The caller's delegated AI jobs on one document, for the prompt bar's
 * progress panel: loads them on mount (a running job survives a reload),
 * follows the current one over its SSE stream (polling when the stream
 * fails), and reloads when awareness shows one of my jobs joining or
 * leaving the document (`myJobIds`). Cancel / resume / undo call the job
 * routes. Progress is private to the person who started the job.
 */
export function useAiJobs(docId: () => string, myJobIds: () => readonly string[], options: UseAiJobsOptions = {}) {
  const { extractError } = useErrorHandler()
  const createEventSource = options.createEventSource === undefined ? defaultEventSourceFactory() : options.createEventSource
  const pollMs = options.pollMs ?? POLL_MS

  const jobs = ref<AiJobView[]>([])
  const notes = ref<AiJobNote[]>([])
  const dismissed = ref<Set<string>>(new Set())
  const busy = ref(false)
  const error = ref<string | null>(null)
  const undone = ref<{ jobId: string, reverted: number, skipped: number } | null>(null)

  /** The job the panel shows: the newest one still active, else the newest recent one not dismissed. */
  const current = computed<AiJobView | null>(() => {
    const visible = jobs.value.filter(j => SHOWN.has(j.status) && !dismissed.value.has(j.jobId))
    return visible.find(j => ACTIVE.has(j.status)) ?? visible[0] ?? null
  })

  let source: AiEventSource | null = null
  let followed: string | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function stopFollowing(): void {
    source?.close()
    source = null
    followed = null
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  function merge(patch: Partial<AiJobView> & { jobId: string }): void {
    jobs.value = jobs.value.map(j => (j.jobId === patch.jobId ? { ...j, ...patch } : j))
  }

  async function loadOne(jobId: string): Promise<void> {
    try {
      const res = await apiFetch('/api/docs/:docId/ai-jobs/:jobId', { path: { docId: docId(), jobId } })
      if (jobs.value.some(j => j.jobId === jobId)) merge(res.job)
      else jobs.value = [res.job, ...jobs.value]
      notes.value = res.notes
      if (!ACTIVE.has(res.job.status)) stopFollowing()
    } catch {
      stopFollowing()
    }
  }

  function poll(jobId: string): void {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      void loadOne(jobId)
    }, pollMs)
  }

  function follow(job: AiJobView | null): void {
    if (!job || !ACTIVE.has(job.status)) {
      if (followed && job?.jobId !== followed) stopFollowing()
      return
    }
    if (followed === job.jobId) return
    stopFollowing()
    followed = job.jobId
    if (!createEventSource) {
      poll(job.jobId)
      return
    }
    const es = createEventSource(`/api/docs/${encodeURIComponent(docId())}/ai-jobs/${encodeURIComponent(job.jobId)}/stream`)
    source = es
    es.addEventListener('progress', (event) => {
      if (typeof event.data !== 'string') return
      try {
        merge(JSON.parse(event.data) as Partial<AiJobView> & { jobId: string })
      } catch { /* a malformed event is skipped */ }
    })
    es.addEventListener('end', () => {
      const id = job.jobId
      stopFollowing()
      void loadOne(id)
    })
    es.onerror = () => {
      // Closed or refused: poll the job instead of letting EventSource retry forever.
      if (es.readyState === 2) {
        source = null
        poll(job.jobId)
      }
    }
  }

  async function load(): Promise<void> {
    try {
      const res = await apiFetch('/api/docs/:docId/ai-jobs', { path: { docId: docId() } })
      const now = Date.now()
      jobs.value = res.jobs.filter(j => ACTIVE.has(j.status) || now - Date.parse(j.finishedAt ?? j.createdAt) < RECENT_MS)
      const job = current.value
      if (job && !ACTIVE.has(job.status)) await loadOne(job.jobId)
    } catch {
      // No AI rights or offline: no panel.
      jobs.value = []
    }
  }

  watch(current, job => follow(job))
  watch(() => myJobIds().join(','), () => {
    void load()
  })
  onMounted(() => {
    void load()
  })
  onScopeDispose(stopFollowing)

  async function act(jobId: string, action: 'cancel' | 'resume'): Promise<void> {
    if (busy.value) return
    busy.value = true
    error.value = null
    try {
      const path = { docId: docId(), jobId }
      const res = action === 'cancel'
        ? await apiFetch('/api/docs/:docId/ai-jobs/:jobId/cancel', { method: 'post', path })
        : await apiFetch('/api/docs/:docId/ai-jobs/:jobId/resume', { method: 'post', path })
      merge(res.job)
    } catch (e) {
      error.value = extractError(e).message
    } finally {
      busy.value = false
    }
  }

  async function undo(jobId: string): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    error.value = null
    try {
      const res = await apiFetch('/api/docs/:docId/ai-jobs/:jobId/revert', { method: 'post', path: { docId: docId(), jobId } })
      undone.value = { jobId, reverted: res.reverted, skipped: res.skipped }
      merge({ jobId, status: 'reverted' })
      return true
    } catch (e) {
      error.value = extractError(e).message
      return false
    } finally {
      busy.value = false
    }
  }

  function dismiss(jobId: string): void {
    dismissed.value = new Set([...dismissed.value, jobId])
    if (undone.value?.jobId === jobId) undone.value = null
  }

  return {
    jobs: readonly(jobs),
    current,
    notes: readonly(notes),
    busy: readonly(busy),
    error: readonly(error),
    undone: readonly(undone),
    reload: load,
    cancel: (jobId: string) => act(jobId, 'cancel'),
    resume: (jobId: string) => act(jobId, 'resume'),
    undo,
    dismiss
  }
}
