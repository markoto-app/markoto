import { describe, it, expect } from 'vitest'
import en from '../../../i18n/locales/en.json'

// Pin the AI surfaces' i18n keys. Same rationale as
// `tests/unit/legal/i18nKeys.test.ts`: a typo in a
// `t('ai.workspaceBudgetExhaustedTitle')` call would render the
// literal key string in the UI, easy to miss in code review,
// caught here at unit-time.
//
// Whenever you add or rename a key referenced by an AI component
// (AIPromptBar, UsageBadge, useAI, useAiCredits,
// EditorLayout's onBudgetExhausted), add it to the list below.

const EXPECTED_KEYS: string[] = [
  // Prompt bar: placeholder + status
  'ai.placeholder',
  'ai.exhaustedPlaceholder',
  'ai.workspaceExhaustedPlaceholder',
  'ai.loginRequired',
  'ai.statusThinking',
  'ai.send',

  // Budget exhausted: self-bill
  'ai.budgetExhaustedTitle',
  'ai.budgetExhaustedDescription',
  'ai.upgradeCta',

  // Budget exhausted: workspace-shared
  'ai.workspaceBudgetExhaustedTitle',
  'ai.workspaceBudgetExhaustedDescription',

  // Generic AI failure toast
  'ai.failed',

  // Voice / dictation toasts
  'ai.dictateBudgetExhaustedTitle',
  'ai.dictateBudgetExhaustedDescription',
  'ai.dictateIdleDescription',
  'ai.dictateErrorTitle',
  'ai.micBlocked',
  'ai.micStart',

  // Response panel
  'ai.responseLabel',
  'ai.responseQuestionLabel',
  'ai.responseDismiss',

  // Topbar usage label
  'ai.remainingLabel'
]

function resolveKey(obj: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc === undefined || acc === null) return undefined
    if (typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[part]
  }, obj)
}

describe('AI i18n keys: every referenced key resolves to a non-empty string', () => {
  for (const key of EXPECTED_KEYS) {
    it(`${key} exists in en.json`, () => {
      const v = resolveKey(en as Record<string, unknown>, key)
      expect(typeof v, `${key} should be a string`).toBe('string')
      expect((v as string).trim().length, `${key} should not be empty`).toBeGreaterThan(0)
    })
  }
})
