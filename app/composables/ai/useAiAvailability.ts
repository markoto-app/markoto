import type { AiAvailability } from '~~/shared/ai/providers'

/**
 * The workspace of the document being edited (set by the editor, null
 * elsewhere). Inside a Team / Business workspace its plan decides which
 * platform AI capabilities are unlocked, so availability and the
 * voice prompt send it along.
 */
export function useAiWorkspaceContext() {
  return useState<string | null>('ai-workspace-context', () => null)
}

/**
 * Which AI capabilities the signed-in user can use right now (their own
 * BYOK key → the instance default → none), from `GET /api/ai/availability`.
 *
 * `useState`-backed so every AI entry point (prompt bar, voice mic,
 * dictation button, `@ai` in comments, the AI Points meter) reads one
 * snapshot. Call `refresh()` after the settings page saves or deletes
 * a provider.
 *
 * Until the first fetch resolves `availability` is null; consumers treat
 * null as "unknown" and keep their default rendering so the editor
 * doesn't flash a call-to-action on every page load.
 */
export function useAiAvailability() {
  const { loggedIn } = useUserSession()
  const state = useState<AiAvailability | null>('ai-availability', () => null)
  const loading = useState<boolean>('ai-availability-loading', () => false)
  const workspaceContext = useAiWorkspaceContext()

  async function refresh(): Promise<void> {
    if (!loggedIn.value) {
      state.value = null
      return
    }
    loading.value = true
    try {
      const workspaceId = workspaceContext.value
      state.value = await $fetch<AiAvailability>('/api/ai/availability', { query: workspaceId ? { workspaceId } : {} })
    } catch {
      // Keep the last known snapshot on a transient failure; the server
      // still refuses AI calls without a provider (409 ai/provider-missing).
    } finally {
      loading.value = false
    }
  }

  if (import.meta.client && loggedIn.value && state.value === null && !loading.value) {
    void refresh()
  }

  watch(loggedIn, (isIn) => {
    if (!isIn) {
      state.value = null
      return
    }
    void refresh()
  })

  if (import.meta.client) {
    watch(workspaceContext, () => {
      if (loggedIn.value) void refresh()
    })
  }

  /** Known AND unavailable — only then do we swap UI for a call-to-action. */
  const chatMissing = computed(() => state.value !== null && !state.value.chat.available)
  const transcriptionAvailable = computed(() => state.value === null || state.value.transcription.available)
  const liveDictationAvailable = computed(() => state.value === null || state.value.transcription.liveDictation)
  const chatPlatformBilled = computed(() => state.value === null || state.value.chat.platformBilled)
  /** The platform has voice / images, but not on the plan that pays here. */
  const transcriptionLocked = computed(() => state.value?.transcription.locked === 'plan')
  const imageLocked = computed(() => state.value?.image.locked === 'plan')
  /** Operator has Staan / Jina keys; null snapshot → assume available. */
  const webSearchAvailable = computed(() => state.value === null || state.value.webTools.search)
  const pageFetchAvailable = computed(() => state.value === null || state.value.webTools.fetch)
  /**
   * Does anything the user can do consume platform AI Points? False when
   * every available capability runs on their own key — then the points
   * meter would be noise.
   */
  const anyPlatformBilled = computed(() => {
    const s = state.value
    if (!s) return true
    return s.chat.platformBilled || s.image.platformBilled || s.transcription.platformBilled
  })

  return {
    availability: state,
    loading,
    refresh,
    chatMissing,
    transcriptionAvailable,
    liveDictationAvailable,
    chatPlatformBilled,
    transcriptionLocked,
    imageLocked,
    webSearchAvailable,
    pageFetchAvailable,
    anyPlatformBilled
  }
}

/** Where the "Add your API key" call-to-actions point. */
export const AI_SETTINGS_ROUTE = '/settings/ai'
