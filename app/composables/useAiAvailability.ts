import type { AiAvailability } from '~~/shared/ai/providers'

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
 * null as "unknown" and keep their default (pre-BYOK) rendering so the
 * editor doesn't flash a call-to-action on every page load.
 */
export function useAiAvailability() {
  const { loggedIn } = useUserSession()
  const state = useState<AiAvailability | null>('ai-availability', () => null)
  const loading = useState<boolean>('ai-availability-loading', () => false)

  async function refresh(): Promise<void> {
    if (!loggedIn.value) {
      state.value = null
      return
    }
    loading.value = true
    try {
      state.value = await $fetch<AiAvailability>('/api/ai/availability')
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

  /** Known AND unavailable — only then do we swap UI for a call-to-action. */
  const chatMissing = computed(() => state.value !== null && !state.value.chat.available)
  const transcriptionAvailable = computed(() => state.value === null || state.value.transcription.available)
  const liveDictationAvailable = computed(() => state.value === null || state.value.transcription.liveDictation)
  const chatPlatformBilled = computed(() => state.value === null || state.value.chat.platformBilled)
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
    anyPlatformBilled
  }
}

/** Where the "Add your API key" call-to-actions point. */
export const AI_SETTINGS_ROUTE = '/settings/ai'
