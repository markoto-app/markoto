// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { CommonAppOverlays } from '#components'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'

// The server-render page (/_internal/render/*) is loaded by the Playwright
// sidecar and captured as PDF/PNG. Regression: with legal surfaces on (the
// hosted SaaS) the consent banner mounted there and painted over the
// rendered pages. App-level overlays must stay off /_internal/* routes and
// keep working everywhere else. Mounts only the overlay layer (not the
// pages behind those routes).

registerEndpoint('/api/consent', () => ({ promptRequired: true, decisions: [], version: 1 }))

// The banner teleports to <body>, so look it up in the document, not the wrapper.
function consentBanner(): Element | null {
  return document.body.querySelector('[data-testid="consent-banner"]')
}

function enableLegalSurfaces(): void {
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, legalSurfaces: true }
}

describe('app overlays on the server-render page', () => {
  it('shows the consent banner on a normal route', async () => {
    enableLegalSurfaces()
    const wrapper = await mountSuspended(CommonAppOverlays, { route: '/pricing' })
    await flushPromises()
    expect(consentBanner()).not.toBeNull()
    wrapper.unmount()
  })

  it('never mounts the consent banner on /_internal/render/*', async () => {
    enableLegalSurfaces()
    const wrapper = await mountSuspended(CommonAppOverlays, { route: '/_internal/render/doc123' })
    await flushPromises()
    expect(consentBanner()).toBeNull()
    wrapper.unmount()
  })
})
