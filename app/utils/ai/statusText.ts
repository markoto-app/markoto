import type { MyAiSessionInfo } from '~/types/ai/session'

/**
 * The line the prompt bar shows while the caller's AI session runs. The
 * states the client can tell by itself read in the UI language: waiting
 * for an Allow / Deny answer, and thinking. A tool step keeps the
 * server's description of it (it names the query, page or passage).
 */
export function aiStatusText(
  session: Pick<MyAiSessionInfo, 'phase' | 'message' | 'confirmation'>,
  t: (key: string) => string
): string {
  if (session.confirmation) return t('ai.confirm.waiting')
  if (session.phase === 'thinking') return t('ai.statusThinking')
  return session.message || t('ai.statusThinking')
}
