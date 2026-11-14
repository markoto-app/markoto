import type { AiStatusStep } from '~~/shared/ai/statusSteps'
import type { MyAiSessionInfo } from '~/types/ai/session'

/** vue-i18n's `t` as these helpers call it (named values, optional plural count). */
export type StatusTranslate = (key: string, named?: Record<string, unknown>, plural?: number) => string

/** A server status step in the UI language (`ai.step.<key>` in the locale files). */
export function aiStepText(step: AiStatusStep, t: StatusTranslate): string {
  const named = step.count === undefined ? step.params ?? {} : { count: step.count, ...step.params }
  return step.count === undefined ? t(`ai.step.${step.key}`, named) : t(`ai.step.${step.key}`, named, step.count)
}

/**
 * The line the prompt bar shows while the caller's AI session runs, in
 * the UI language: waiting for an Allow / Deny answer, thinking, and the
 * server's step (which names the query, page or passage). A step without
 * a code (a provider's own error sentence) keeps the server's text.
 */
export function aiStatusText(
  session: Pick<MyAiSessionInfo, 'phase' | 'message' | 'step' | 'confirmation'>,
  t: StatusTranslate
): string {
  if (session.confirmation) return t('ai.confirm.waiting')
  if (session.phase === 'thinking') return t('ai.statusThinking')
  if (session.step) return aiStepText(session.step, t)
  return session.message || t('ai.statusThinking')
}
