import { describe, expect, it } from 'vitest'
import { AI_STATUS_STEPS, aiStatus, parseAiStatusStep, renderStatusTemplate, type AiStatusStepKey } from '../../../shared/ai/statusSteps'
import { MEMBER_LIMIT_REACHED_MESSAGE, TEAM_BUDGET_EXHAUSTED_MESSAGE } from '../../../server/utils/litellm/workspaceTeams'
import { FREE_ALLOWANCE_EXHAUSTED_MESSAGE } from '../../../server/utils/litellm/freeTierTeam'
import { AI_RATE_LIMITED_MESSAGE, AI_UNAVAILABLE_MESSAGE } from '../../../server/utils/agentic/loopErrorMessage'
import en from '../../../i18n/locales/en.json'
import de from '../../../i18n/locales/de.json'
import fr from '../../../i18n/locales/fr.json'
import es from '../../../i18n/locales/es.json'
import ja from '../../../i18n/locales/ja.json'
import zh from '../../../i18n/locales/zh.json'

// The AI's status lines travel as step codes; the client renders them from
// `ai.step.*`. The server's English text and en.json must be the same
// strings, and every locale needs every step with the same placeholders.

const KEYS = Object.keys(AI_STATUS_STEPS) as AiStatusStepKey[]
const LOCALES = { de, fr, es, ja, zh }

function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(/\{(\w+)\}/g)].map(m => m[1]!))].sort()
}

describe('AI status steps', () => {
  it('en.json holds the server\'s English text for every step', () => {
    expect(en.ai.step).toEqual(AI_STATUS_STEPS)
  })

  it.each(Object.entries(LOCALES))('%s has every step with the same placeholders', (_locale, messages) => {
    const steps = messages.ai.step as Record<string, string>
    expect(Object.keys(steps).sort()).toEqual([...KEYS].sort())
    for (const key of KEYS) expect(placeholders(steps[key]!), key).toEqual(placeholders(AI_STATUS_STEPS[key]))
  })

  it('the fixed error sentences are the server\'s own', () => {
    expect(AI_STATUS_STEPS.teamBudgetExhausted).toBe(TEAM_BUDGET_EXHAUSTED_MESSAGE)
    expect(AI_STATUS_STEPS.memberLimitReached).toBe(MEMBER_LIMIT_REACHED_MESSAGE)
    expect(AI_STATUS_STEPS.freeAllowanceExhausted).toBe(FREE_ALLOWANCE_EXHAUSTED_MESSAGE)
    expect(AI_STATUS_STEPS.aiUnavailable).toBe(AI_UNAVAILABLE_MESSAGE)
    expect(AI_STATUS_STEPS.aiRateLimited).toBe(AI_RATE_LIMITED_MESSAGE)
  })

  it('renders placeholders and the plural form', () => {
    expect(aiStatus('webSearch', { query: 'mistral pricing' })).toEqual({
      text: 'Searching the web for "mistral pricing"',
      step: { key: 'webSearch', params: { query: 'mistral pricing' } }
    })
    expect(aiStatus('renderPages', undefined, 1).text).toBe('Rendering 1 page…')
    expect(aiStatus('renderPages', undefined, 4).text).toBe('Rendering 4 pages…')
    expect(aiStatus('done')).toEqual({ text: 'Done', step: { key: 'done' } })
    expect(renderStatusTemplate('Reading {title}…', {})).toBe('Reading {title}…')
  })

  it('reads steps back from untrusted JSON', () => {
    expect(parseAiStatusStep({ key: 'webSearch', params: { query: 'q', bad: 3 }, count: 2 })).toEqual({ key: 'webSearch', params: { query: 'q' }, count: 2 })
    expect(parseAiStatusStep({ key: 'nope' })).toBe(null)
    expect(parseAiStatusStep({ key: 'toString' })).toBe(null)
    expect(parseAiStatusStep('done')).toBe(null)
    expect(parseAiStatusStep(null)).toBe(null)
  })
})
