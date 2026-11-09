import { describe, it, expect } from 'vitest'
import { buildWorkspaceBillingEmail, type WorkspaceBillingEmail } from '../../server/utils/email/workspaceBillingEmails'
import { budgetAlertLevel } from '../../server/utils/workspaceBudgetAlerts'
import { INVITE_EMAIL_LOCALES } from '../../server/utils/workspaceInvites'

const KINDS: WorkspaceBillingEmail[] = ['budget_80', 'budget_100', 'payment_failed', 'seat_added', 'ending', 'ended']

describe('workspace billing emails', () => {
  it.each(INVITE_EMAIL_LOCALES)('%s: every kind names the workspace and links the billing tab', (locale) => {
    for (const kind of KINDS) {
      const email = buildWorkspaceBillingEmail(kind, locale, { workspace: 'Northwind', seats: 5, actor: 'Maya', date: '1 Dec 2027' }, 'https://markoto.app/w/ws1?tab=billing')
      expect(email.subject, `${locale} ${kind}`).toContain('Northwind')
      expect(email.body, `${locale} ${kind}`).toContain('Northwind')
      expect(email.body, `${locale} ${kind}`).toContain('https://markoto.app/w/ws1?tab=billing')
      expect(email.body).not.toMatch(/undefined|\$\{/)
    }
  })

  it('names the seats and who added one; leaves the link out without a site URL', () => {
    const email = buildWorkspaceBillingEmail('seat_added', 'en', { workspace: 'Northwind', seats: 5, actor: 'Maya' }, null)
    expect(email.body).toContain('Maya added a seat')
    expect(email.body).toContain('5 seats')
    expect(email.body).not.toContain('Billing:')
  })

  it('caps very long workspace names', () => {
    const email = buildWorkspaceBillingEmail('ended', 'en', { workspace: 'x'.repeat(200) }, null)
    expect(email.subject.length).toBeLessThan(140)
  })

  it('German copy uses ss, never ß', () => {
    for (const kind of KINDS) {
      const email = buildWorkspaceBillingEmail(kind, 'de', { workspace: 'W', seats: 3, date: 'x' }, null)
      expect(email.subject + email.body).not.toContain('ß')
    }
  })
})

describe('budgetAlertLevel', () => {
  it.each([
    [0, 20, null],
    [15.99, 20, null],
    [16, 20, 0.8],
    [19.9, 20, 0.8],
    [20, 20, 1],
    [25, 20, 1],
    [5, 0, null]
  ])('spend %s of %s → %s', (spend, budget, level) => {
    expect(budgetAlertLevel(spend, budget)).toBe(level)
  })
})
