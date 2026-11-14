import { describe, expect, it } from 'vitest'
import { aiStatusText } from '../../../app/utils/ai/statusText'
import de from '../../../i18n/locales/de.json'

const t = (key: string, named?: Record<string, unknown>, plural?: number): string =>
  `t:${key}${named && Object.keys(named).length > 0 ? JSON.stringify(named) : ''}${plural === undefined ? '' : `#${plural}`}`
const confirmation = { id: 'c1', tool: 'web_search', target: 'x', expiresAt: 0 }

describe('aiStatusText', () => {
  it('reads "waiting for your confirmation" from the locale while a request is open', () => {
    // The server's own status line for this state is English.
    expect(aiStatusText({ phase: 'tool', message: 'Waiting for your confirmation…', step: { key: 'waitingConfirmation' }, confirmation }, t)).toBe('t:ai.confirm.waiting')
  })

  it('translates the thinking phase whatever text the server sent', () => {
    expect(aiStatusText({ phase: 'thinking', message: 'Thinking…', step: { key: 'thinking' }, confirmation: null }, t)).toBe('t:ai.statusThinking')
  })

  it('renders a tool step in the UI language with its values', () => {
    expect(aiStatusText({ phase: 'tool', message: 'Searching the web for "x"', step: { key: 'webSearch', params: { query: 'x' } }, confirmation: null }, t))
      .toBe('t:ai.step.webSearch{"query":"x"}')
  })

  it('passes the count for plural steps', () => {
    expect(aiStatusText({ phase: 'tool', message: 'Rendering 3 pages…', step: { key: 'renderPages', count: 3 }, confirmation: null }, t))
      .toBe('t:ai.step.renderPages{"count":3}#3')
  })

  it('keeps the server text of a step without a code', () => {
    expect(aiStatusText({ phase: 'error', message: 'Your provider refused the key.', step: null, confirmation: null }, t)).toBe('Your provider refused the key.')
  })

  it('falls back to thinking when a step has no text', () => {
    expect(aiStatusText({ phase: 'tool', message: null, step: null, confirmation: null }, t)).toBe('t:ai.statusThinking')
  })

  it('has the German texts', () => {
    expect(de.ai.confirm.waiting).toBe('Wartet auf deine Bestätigung…')
    expect(de.ai.statusThinking).toBe('markoto denkt nach…')
    expect(de.ai.step.webSearch).toBe('Sucht im Web nach „{query}“')
  })
})
