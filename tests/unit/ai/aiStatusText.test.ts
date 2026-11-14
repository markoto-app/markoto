import { describe, expect, it } from 'vitest'
import { aiStatusText } from '../../../app/utils/ai/statusText'
import de from '../../../i18n/locales/de.json'

const t = (key: string): string => `t:${key}`
const confirmation = { id: 'c1', tool: 'web_search', target: 'x', expiresAt: 0 }

describe('aiStatusText', () => {
  it('reads "waiting for your confirmation" from the locale while a request is open', () => {
    // The server's own status line for this state is English.
    expect(aiStatusText({ phase: 'tool', message: 'Waiting for your confirmation…', confirmation }, t)).toBe('t:ai.confirm.waiting')
  })

  it('translates the thinking phase whatever text the server sent', () => {
    expect(aiStatusText({ phase: 'thinking', message: 'Thinking…', confirmation: null }, t)).toBe('t:ai.statusThinking')
  })

  it('keeps the description of a tool step', () => {
    expect(aiStatusText({ phase: 'tool', message: 'Searching the web for "x"', confirmation: null }, t)).toBe('Searching the web for "x"')
  })

  it('falls back to thinking when a step has no text', () => {
    expect(aiStatusText({ phase: 'tool', message: null, confirmation: null }, t)).toBe('t:ai.statusThinking')
  })

  it('has the German texts', () => {
    expect(de.ai.confirm.waiting).toBe('Wartet auf deine Bestätigung…')
    expect(de.ai.statusThinking).toBe('markoto denkt nach…')
  })
})
