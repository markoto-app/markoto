// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { CommonAppOverlays } from '#components'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'

// App-level overlays with the legal surfaces on (hosted SaaS).
//
// markoto stores only essential cookies, so there is no cookie banner at
// all (CONSENT_VERSION 2): even if the consent endpoint asked for a
// prompt, nothing may paint a consent bar over a page. The server-render
// page (/_internal/render/*, captured as PDF/PNG by the Playwright
// sidecar) must stay free of every overlay; regression: a consent banner
// once painted over rendered pages.

registerEndpoint('/api/consent', () => ({ promptRequired: true, decisions: {}, currentVersion: 2 }))

function bodyHas(selector: string): boolean {
  return document.body.querySelector(selector) !== null
}

function enableLegalSurfaces(): void {
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, legalSurfaces: true }
}

describe('app overlays', () => {
  it('never shows a cookie / consent banner on a normal route', async () => {
    enableLegalSurfaces()
    const wrapper = await mountSuspended(CommonAppOverlays, { route: '/pricing' })
    await flushPromises()
    expect(bodyHas('[data-testid="consent-banner"]')).toBe(false)
    wrapper.unmount()
  })

  it('mounts no overlay on /_internal/render/*', async () => {
    enableLegalSurfaces()
    const wrapper = await mountSuspended(CommonAppOverlays, { route: '/_internal/render/doc123' })
    await flushPromises()
    expect(bodyHas('[data-testid="consent-banner"]')).toBe(false)
    wrapper.unmount()
  })
})
