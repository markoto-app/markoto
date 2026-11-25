import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_EVENTS,
  FUNNELS,
  loginProviderOfPath,
  newTourDepths,
  resolveClickEvent
} from '../../../shared/analytics/events'

const NAMES = new Set<string>(Object.values(ANALYTICS_EVENTS))

describe('event names', () => {
  it('are snake_case object_action, unique and fit Umami (50 chars)', () => {
    const names = Object.values(ANALYTICS_EVENTS)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) {
      expect(n).toMatch(/^[a-z]+(_[a-z]+)+$/)
      expect(n.length).toBeLessThanOrEqual(50)
    }
  })

  it('every funnel step is a defined event or a public page', () => {
    for (const funnel of Object.values(FUNNELS)) {
      expect(funnel.steps.length).toBeGreaterThanOrEqual(3)
      const events = funnel.steps.flatMap(step => ('event' in step ? [step.event] : []))
      const paths = funnel.steps.flatMap(step => ('path' in step ? [step.path] : []))
      expect(events.filter(e => !NAMES.has(e))).toEqual([])
      expect(paths.filter(p => !p.startsWith('/'))).toEqual([])
    }
  })
})

describe('resolveClickEvent', () => {
  it('maps the fixed test ids', () => {
    expect(resolveClickEvent(['tour-start-writing'])).toEqual({ name: 'start_writing_clicked', data: { placement: 'tour_hero' } })
    expect(resolveClickEvent(['header-github-link', 'marketing-header'])).toEqual({ name: 'github_clicked', data: { placement: 'header' } })
    expect(resolveClickEvent(['footer-self-host-link', 'legal-footer'])).toEqual({ name: 'selfhost_clicked', data: { placement: 'footer' } })
    // Both of the hero picture's play buttons (stacked and pinned layouts).
    expect(resolveClickEvent(['tour-demo-play', 'product-tour'])).toEqual({ name: 'demo_video_open', data: { placement: 'tour_hero' } })
    expect(resolveClickEvent(['tour-demo-play-stage', 'product-tour'])).toEqual({ name: 'demo_video_open', data: { placement: 'tour_hero' } })
  })

  it('takes the innermost known id (an icon inside a button inside a section)', () => {
    expect(resolveClickEvent(['pricing-self-hosted-cta', 'pricing-option-self-hosted', 'pricing-options'])?.data).toEqual({ plan: 'self_hosted', action: 'self_host' })
  })

  it('a waitlist button names the plan card it sits in', () => {
    expect(resolveClickEvent(['pricing-join-waitlist', 'pricing-tier-team', 'pricing-plans'])).toEqual({ name: 'pricing_cta_clicked', data: { plan: 'team', action: 'waitlist' } })
    expect(resolveClickEvent(['pricing-join-waitlist'])).toEqual({ name: 'pricing_cta_clicked', data: { action: 'waitlist' } })
  })

  it('checkout buttons of paid plans only', () => {
    expect(resolveClickEvent(['pricing-buy-pro'])).toEqual({ name: 'checkout_started', data: { plan: 'pro' } })
    expect(resolveClickEvent(['pricing-buy-evil'])).toBeNull()
  })

  it('anything else is not an event', () => {
    expect(resolveClickEvent(['editor-toolbar-bold', 'editor'])).toBeNull()
    expect(resolveClickEvent([])).toBeNull()
  })
})

describe('helpers', () => {
  it('recognises sign-in links', () => {
    expect(loginProviderOfPath('/auth/google')).toBe('google')
    expect(loginProviderOfPath('/auth/github')).toBe('github')
    expect(loginProviderOfPath('/auth/oidc')).toBe('oidc')
    expect(loginProviderOfPath('/auth/sso/x/metadata')).toBeNull()
    expect(loginProviderOfPath('/auth/googlex')).toBeNull()
  })

  it('tour depth marks fire once each, all passed marks at once', () => {
    expect(newTourDepths(10, new Set())).toEqual([])
    expect(newTourDepths(55, new Set())).toEqual([25, 50])
    expect(newTourDepths(80, new Set([25, 50]))).toEqual([75])
    expect(newTourDepths(99.6, new Set([25, 50, 75]))).toEqual([100])
  })
})
