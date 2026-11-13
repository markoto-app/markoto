import { onScopeDispose } from 'vue'
import type { Awareness } from 'y-protocols/awareness'
import type { AiSessionInfo } from '~/types/ai/session'

/**
 * The AI sessions running on a document, as every participant sees them in
 * Y.js awareness (the AI joins as its own client): which one is mine and
 * which belong to someone else. Part of `useAI`.
 */
export function useAwarenessAiSessions(awareness: Awareness) {
  const { loggedIn, user: sessionUser } = useUserSession()

  // Derived from awareness entries with `isAI: true` + an `aiSession` block.
  const activeSessions = ref<AiSessionInfo[]>([])

  function refresh() {
    const list: AiSessionInfo[] = []
    for (const state of awareness.getStates().values()) {
      const user = state?.user
      const ai = state?.aiSession
      const status = state?.aiStatus
      if (!user?.isAI || !ai?.sessionId) continue
      list.push({
        sessionId: ai.sessionId,
        initiatorName: ai.initiatorName,
        initiatorUserId: ai.initiatorUserId,
        phase: status?.phase ?? 'thinking',
        commentThreadId: typeof ai.commentThreadId === 'string' && ai.commentThreadId.length > 0
          ? ai.commentThreadId
          : null
      })
    }
    activeSessions.value = list
  }

  awareness.on('change', refresh)
  refresh()
  onScopeDispose(() => {
    awareness.off('change', refresh)
  })

  const mySessionId = computed<string | null>(() => {
    if (!loggedIn.value) return null
    const myId = sessionUser.value?.id
    if (typeof myId !== 'number') return null
    const mine = activeSessions.value.find(s => s.initiatorUserId === myId)
    return mine?.sessionId ?? null
  })

  const otherSessions = computed<AiSessionInfo[]>(() => {
    if (!loggedIn.value) return activeSessions.value
    const myId = sessionUser.value?.id
    return activeSessions.value.filter(s => s.initiatorUserId !== myId)
  })

  return { activeSessions, mySessionId, otherSessions }
}
