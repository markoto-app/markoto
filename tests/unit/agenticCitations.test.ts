import { describe, expect, it } from 'vitest'
import { fetchUrlCitationReminder, webSearchCitationReminder } from '../../server/utils/agentic/citations'

describe('citation reminders on web tool results', () => {
  it('web_search: asks for Markdown links to the listed sources', () => {
    const text = webSearchCitationReminder([{ title: 'Vue releases', uri: 'https://example.org/vue/releases' }])
    expect(text).toMatch(/MUST carry a Markdown link/)
    expect(text).toContain('([Vue releases](https://example.org/vue/releases))')
    expect(text).toMatch(/only URLs listed above/)
  })

  it('web_search: nothing to cite without sources', () => {
    expect(webSearchCitationReminder([])).toBe('')
  })

  it('fetch_url: names the page and the link to write', () => {
    const text = fetchUrlCitationReminder('https://vuejs.org/guide/introduction.html')
    expect(text).toContain('Source page: https://vuejs.org/guide/introduction.html')
    expect(text).toContain('[page title](https://vuejs.org/guide/introduction.html)')
  })

  it('fetch_url: nothing without a URL', () => {
    expect(fetchUrlCitationReminder('')).toBe('')
  })
})
