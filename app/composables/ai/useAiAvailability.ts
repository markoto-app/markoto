import type { AiAvailability } from '~~/shared/ai/providers'
import { useAiAvailabilityQuery, useInvalidateAiAvailability } from '~/queries/ai'

/**
 * The workspace of the document being edited (set by the editor, null
 * elsewhere). Inside a Team / Business workspace its plan decides which
 * platform AI capabilities are unlocked, so availability and the
 * voice prompt send it along.
 */
export function useAiWorkspaceContext() {
  return useState<string | null>('ai-workspace-context', () => null)
}

let nextClaim = 0

/**
 * Sets the AI workspace context from `source` while the calling component
 * is mounted (the editor of a workspace document, a workspace page), and
 * clears it on unmount. On navigation the next page mounts before the old
 * one unmounts, so only the latest claim may clear it.
 */
export function useClaimAiWorkspaceContext(source: () => string | null) {
  const context = useAiWorkspaceContext()
  const owner = useState<number | null>('ai-workspace-context-owner', () => null)
  const claim = ++nextClaim
  watch(source, (ws) => {
    owner.value = claim
    context.value = ws ?? null
  }, { immediate: true })
  onUnmounted(() => {
    if (owner.value !== claim) return
    owner.value = null
    context.value = null
  })
}

/**
 * Which AI capabilities the signed-in user can use right now (their own
 * BYOK key → the instance default → none), from `GET /api/ai/availability`
 * for the current workspace context.
 *
 * One cached query per context (app/queries/ai.ts), so every AI entry point
 * (prompt bar, voice mic, dictation button, `@ai` in comments, the AI Points
 * meter) shares one request. Saving or removing a provider invalidates it
 * through its mutation; `refresh()` is for the AI loop reporting a missing
 * provider.
 *
 * Until the first fetch resolves `availability` is null; consumers treat
 * null as "unknown" and keep their default rendering so the editor
 * doesn't flash a call-to-action on every page load.
 */
export function useAiAvailability() {
  const { loggedIn } = useUserSession()
  const workspaceContext = useAiWorkspaceContext()
  const query = useAiAvailabilityQuery(workspaceContext)
  const invalidateAvailability = useInvalidateAiAvailability()
  // A failed refetch keeps the last known snapshot; the server still refuses
  // AI calls without a provider (409 ai/provider-missing).
  const state = computed<AiAvailability | null>(() => loggedIn.value ? query.data.value ?? null : null)
  const refresh = (): Promise<void> => invalidateAvailability()

  /** Known AND unavailable: only then do we swap UI for a call-to-action. */
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
   * every available capability runs on their own key, then the points
   * meter would be noise.
   */
  const anyPlatformBilled = computed(() => {
    const s = state.value
    if (!s) return true
    return s.chat.platformBilled || s.image.platformBilled || s.transcription.platformBilled
  })

  return {
    availability: state,
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
