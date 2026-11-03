// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { CommonLegalFooter } from '#components'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'

// With only essential cookies there is no consent banner to re-open: the
// footer replaces the old "Privacy choices" button with a short cookie
// note that links to the cookie list in the privacy policy.

function setLegalSurfaces(on: boolean): void {
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, legalSurfaces: on }
}

describe('legal footer cookie note', () => {
  it('links the cookie note to the privacy policy and offers no consent re-open button', async () => {
    setLegalSurfaces(true)
    const wrapper = await mountSuspended(CommonLegalFooter)
    const note = wrapper.find('[data-testid="footer-cookie-note"]')
    expect(note.exists()).toBe(true)
    expect(note.attributes('href')).toBe('/legal/privacy')
    expect(note.text()).toBe('Cookies: essential only')
    expect(wrapper.find('[data-testid="footer-reopen-consent"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('hides legal links and the cookie note on instances without the legal surfaces', async () => {
    setLegalSurfaces(false)
    const wrapper = await mountSuspended(CommonLegalFooter)
    expect(wrapper.find('[data-testid="footer-cookie-note"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
