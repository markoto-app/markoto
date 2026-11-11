import { describe, expect, it } from 'vitest'
import { isOnboardingGatedRequest, onboardingIncomplete } from '../../../server/utils/privacy/onboardingGate'
import { PRIVACY_VERSION, TOS_VERSION } from '../../../shared/legal/versions'

const ACCEPTED = {
  ageConfirmedAt: new Date('2026-01-01T00:00:00Z'),
  privacyVersionAccepted: PRIVACY_VERSION,
  tosVersionAccepted: TOS_VERSION
}

describe('onboardingIncomplete', () => {
  it('is false once age + current Privacy + current ToS are accepted', () => {
    expect(onboardingIncomplete(ACCEPTED)).toBe(false)
  })

  it('requires the age confirmation', () => {
    expect(onboardingIncomplete({ ...ACCEPTED, ageConfirmedAt: null })).toBe(true)
  })

  it('requires the CURRENT privacy and terms versions (stale acceptance re-prompts)', () => {
    expect(onboardingIncomplete({ ...ACCEPTED, privacyVersionAccepted: null })).toBe(true)
    expect(onboardingIncomplete({ ...ACCEPTED, privacyVersionAccepted: PRIVACY_VERSION - 1 })).toBe(true)
    expect(onboardingIncomplete({ ...ACCEPTED, tosVersionAccepted: null })).toBe(true)
    expect(onboardingIncomplete({ ...ACCEPTED, tosVersionAccepted: TOS_VERSION - 1 })).toBe(true)
  })
})

describe('isOnboardingGatedRequest', () => {
  it('gates state-changing API calls, incl. AI', () => {
    expect(isOnboardingGatedRequest('POST', '/api/docs')).toBe(true)
    expect(isOnboardingGatedRequest('POST', '/api/ai/prompt')).toBe(true)
    expect(isOnboardingGatedRequest('POST', '/api/ai/dictate/token')).toBe(true)
    expect(isOnboardingGatedRequest('PUT', '/api/docs/abc/meta')).toBe(true)
    expect(isOnboardingGatedRequest('PATCH', '/api/workspaces/ws/members/2')).toBe(true)
    expect(isOnboardingGatedRequest('DELETE', '/api/docs/abc')).toBe(true)
  })

  it('leaves reads alone so the app can render the gate', () => {
    expect(isOnboardingGatedRequest('GET', '/api/user/account-status')).toBe(false)
    expect(isOnboardingGatedRequest('GET', '/api/_internal/legal/privacy')).toBe(false)
    expect(isOnboardingGatedRequest('HEAD', '/api/docs/abc/token')).toBe(false)
  })

  it('exempts accepting, leaving, exporting, logging out and consent paths', () => {
    for (const [method, path] of [
      ['POST', '/api/user/onboarding-accept'],
      ['DELETE', '/api/_auth/session'],
      ['POST', '/api/consent'],
      ['POST', '/api/user/delete'],
      ['POST', '/api/user/delete-cancel'],
      ['POST', '/api/user/export'],
      ['POST', '/api/waitlist/unsubscribe'],
      ['POST', '/api/waitlist/confirm'],
      ['POST', '/api/webhooks/stripe'],
      ['POST', '/api/internal/activity']
    ] as const) {
      expect(isOnboardingGatedRequest(method, path)).toBe(false)
    }
  })

  it('does not exempt look-alike paths', () => {
    expect(isOnboardingGatedRequest('POST', '/api/user/onboarding-accept/extra')).toBe(true)
    expect(isOnboardingGatedRequest('POST', '/api/user/exports')).toBe(true)
  })
})
