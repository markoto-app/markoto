import { describe, it, expect } from 'vitest'
import { planSupportsTeamBilling, sponsorshipAvailability, sponsorshipTabVisible } from '../../shared/config/sponsorship'
import type { BillingMode } from '../../shared/config/billingMode'

// Workspace AI sponsorship per billing mode: the workspace page shows the
// option disabled (with an upgrade / coming-soon note) instead of hiding
// it — except on a self-hosted instance, where there's no upgrade path.

const BILLING_ON: BillingMode = { billingEnabled: true, plansComingSoon: false }
const COMING_SOON: BillingMode = { billingEnabled: false, plansComingSoon: true }
const SELF_HOST: BillingMode = { billingEnabled: false, plansComingSoon: false }

describe('planSupportsTeamBilling', () => {
  it('only Max and Ultra can sponsor', () => {
    expect(planSupportsTeamBilling('free')).toBe(false)
    expect(planSupportsTeamBilling('pro')).toBe(false)
    expect(planSupportsTeamBilling('max')).toBe(true)
    expect(planSupportsTeamBilling('ultra')).toBe(true)
  })
})

describe('sponsorshipAvailability', () => {
  it('billing on: the plan decides', () => {
    expect(sponsorshipAvailability(BILLING_ON, null)).toBe('loading')
    expect(sponsorshipAvailability(BILLING_ON, 'free')).toBe('needsUpgrade')
    expect(sponsorshipAvailability(BILLING_ON, 'pro')).toBe('needsUpgrade')
    expect(sponsorshipAvailability(BILLING_ON, 'max')).toBe('available')
    expect(sponsorshipAvailability(BILLING_ON, 'ultra')).toBe('available')
  })

  it('hosted free SaaS: coming soon, whatever the plan', () => {
    expect(sponsorshipAvailability(COMING_SOON, null)).toBe('comingSoon')
    expect(sponsorshipAvailability(COMING_SOON, 'ultra')).toBe('comingSoon')
  })

  it('self-hosted: hidden', () => {
    expect(sponsorshipAvailability(SELF_HOST, null)).toBe('hidden')
    expect(sponsorshipAvailability(SELF_HOST, 'max')).toBe('hidden')
  })
})

describe('sponsorshipTabVisible', () => {
  it('shows the tab with billing on or plans coming soon, hides it on self-host', () => {
    expect(sponsorshipTabVisible(BILLING_ON)).toBe(true)
    expect(sponsorshipTabVisible(COMING_SOON)).toBe(true)
    expect(sponsorshipTabVisible(SELF_HOST)).toBe(false)
  })
})
