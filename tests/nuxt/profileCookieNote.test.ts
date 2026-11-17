// @vitest-environment nuxt
import { describe, it, expect, afterEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { LegalCookieNote } from '#components'

// The profile page's storage notice must stay true on both kinds of
// instance: "no analytics" without the cookieless visitor statistics, and
// a mention of them where NUXT_PUBLIC_ANALYTICS_WEBSITE_ID switches them on.

function setWebsiteId(id: string): void {
  useRuntimeConfig().public.analytics.websiteId = id
}

afterEach(() => setWebsiteId(''))

describe('profile cookie note', () => {
  it('says "no analytics" on an instance without visitor statistics', async () => {
    setWebsiteId('')
    const wrapper = await mountSuspended(LegalCookieNote)
    const text = wrapper.get('[data-testid="profile-cookie-note"]').text()
    expect(text).toContain('No analytics, tracking or ads')
    wrapper.unmount()
  })

  it('names the cookieless statistics where the instance counts visits', async () => {
    setWebsiteId('00000000-0000-4000-8000-000000000000')
    const wrapper = await mountSuspended(LegalCookieNote)
    const text = wrapper.get('[data-testid="profile-cookie-note"]').text()
    expect(text).toContain('counted with our own statistics tool, without cookies')
    expect(text).not.toContain('No analytics')
    wrapper.unmount()
  })
})
