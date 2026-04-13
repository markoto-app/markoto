// In-memory registry of active AI sessions.
// Not shared across Nitro workers — each process has its own map.
// The 3-minute sweeper plugin ensures stuck entries eventually clear.

export interface ActiveAISession {
  sessionId: string
  docId: string
  initiatorUserId: number
  initiatorName: string
  initiatorColor: string
  abortController: AbortController
  startedAt: number
}

const activeAISessions = new Map<string, ActiveAISession>()

export function hasUserAiSession(userId: number, docId: string): boolean {
  for (const s of activeAISessions.values()) {
    if (s.initiatorUserId === userId && s.docId === docId) return true
  }
  return false
}

export class DuplicateSessionError extends Error {
  constructor() {
    super('User already has Claude running on this document')
  }
}

export function addAiSession(session: ActiveAISession): void {
  if (hasUserAiSession(session.initiatorUserId, session.docId)) {
    throw new DuplicateSessionError()
  }
  activeAISessions.set(session.sessionId, session)
}

export function allAiSessions(): ActiveAISession[] {
  return Array.from(activeAISessions.values())
}

export function removeAiSession(sessionId: string): void {
  activeAISessions.delete(sessionId)
}

export function getAiSession(sessionId: string): ActiveAISession | undefined {
  return activeAISessions.get(sessionId)
}

/**
 * Snapshot all currently-registered AI sessions. Used by the sweeper plugin.
 * Returns a fresh array — safe to iterate even if the map mutates during sweep.
 */
export function snapshotAiSessions(): ActiveAISession[] {
  return Array.from(activeAISessions.values())
}
