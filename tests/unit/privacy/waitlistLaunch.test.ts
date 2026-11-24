import { describe, expect, it } from 'vitest'
import { buildWaitlistLaunchEmail, waitlistLaunchArgsProblem, WAITLIST_LAUNCH_DISCOUNT_PERCENT } from '../../../server/utils/privacy/waitlistLaunch'
import { WAITLIST_LOCALES } from '../../../server/utils/privacy/waitlist'

// The launch email's content in every waitlist language, and the operator's
// arguments the sender accepts.

describe('buildWaitlistLaunchEmail', () => {
  it.each(WAITLIST_LOCALES)('%s: pricing link, code, discount and the expiry day', (locale) => {
    const mail = buildWaitlistLaunchEmail({ locale, baseUrl: 'https://markoto.app/', code: 'LAUNCH40', expiresOn: '2026-12-10' })
    expect(mail.subject.length).toBeGreaterThan(0)
    expect(mail.body).toContain('https://markoto.app/pricing')
    expect(mail.body).toContain('LAUNCH40')
    expect(mail.body).toContain(String(WAITLIST_LAUNCH_DISCOUNT_PERCENT))
    expect(mail.body).toContain('10')
    expect(mail.body).not.toContain(String.fromCodePoint(0x2014))
  })

  it('writes the day in the reader\'s language', () => {
    const args = { baseUrl: 'https://markoto.app', code: 'LAUNCH40', expiresOn: '2026-12-10' }
    expect(buildWaitlistLaunchEmail({ ...args, locale: 'en' }).body).toContain('December 10, 2026')
    expect(buildWaitlistLaunchEmail({ ...args, locale: 'de' }).body).toContain('10. Dezember 2026')
  })
})

describe('waitlistLaunchArgsProblem', () => {
  const now = new Date('2026-12-01T12:00:00Z')

  it('accepts a code and a day from today on', () => {
    expect(waitlistLaunchArgsProblem('LAUNCH40', '2026-12-10', now)).toBeNull()
    expect(waitlistLaunchArgsProblem('PH_2027-launch', '2026-12-01', now)).toBeNull()
  })

  it.each([
    ['', '2026-12-10', /--code/],
    ['A B', '2026-12-10', /--code/],
    ['LAUNCH40', '', /--expires/],
    ['LAUNCH40', '10.12.2026', /--expires/],
    ['LAUNCH40', '2026-02-30', /--expires/],
    ['LAUNCH40', '2026-11-30', /past/]
  ])('refuses code %j / expiry %j', (code, expires, message) => {
    expect(waitlistLaunchArgsProblem(code, expires, now)).toMatch(message)
  })
})
