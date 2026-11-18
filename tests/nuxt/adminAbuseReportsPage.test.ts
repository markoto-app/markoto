// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import AbuseReportsPage from '~/pages/admin/abuse-reports.vue'

// The abuse queue renders every label through i18n: status, category,
// decision, rule and the notices sent, never a raw key or enum value.

mockNuxtImport('useUserSession', () => () => ({ loggedIn: ref(true), user: ref({ id: 1, name: 'Ada' }), session: ref({}), fetch: vi.fn(), clear: vi.fn() }))
mockNuxtImport('useAccountStatus', () => () => ({ status: ref({ isAdmin: true }) }))

const report = {
  reportId: 'rep_1',
  status: 'actioned',
  category: 'spam',
  body: 'Spam links everywhere',
  docId: 'doc123',
  contentUrl: 'https://markoto.test/d/doc123',
  createdAt: '2026-11-10T10:00:00.000Z',
  acknowledgedAt: null,
  actionedAt: '2026-11-11T10:00:00.000Z',
  notes: null,
  goodFaithConfirmedAt: '2026-11-10T10:00:00.000Z',
  reporterIpTruncated: null,
  reporter: { userId: null, name: 'Bea', email: 'bea@test.local', stillExists: false, signedIn: false },
  actionedBy: { userId: 1, name: 'Ada' },
  decision: { action: 'access_restricted', rule: 'spam_or_seo', explanation: 'Spam.' },
  notices: [{ kind: 'statement_of_reasons', status: 'not_delivered_no_contact', subject: 'Decision', body: 'Body', createdAt: '2026-11-11T10:00:00.000Z' }]
}
const open = { ...report, reportId: 'rep_2', status: 'open', decision: null, notices: [], actionedBy: null, actionedAt: null }

registerEndpoint('/api/admin/abuse-reports', () => [report, open])

describe('admin abuse reports page', () => {
  it('shows each report with translated labels and the actions for open ones', async () => {
    const w = await mountSuspended(AbuseReportsPage, { route: '/admin/abuse-reports' })
    await vi.waitFor(() => expect(w.find('[data-testid="admin-report-rep_1"]').exists()).toBe(true))
    const done = w.get('[data-testid="admin-report-rep_1"]').text()
    expect(done).toContain('Actioned')
    expect(done).toContain('Spam or scam')
    expect(done).toContain('Access restricted · Spam or search-engine manipulation')
    expect(done).toContain('Statement of reasons to the owner · not sent, no contact')
    expect(done).toContain('Account deleted, email kept for follow-up')
    expect(done).toContain('Actioned by Ada')
    expect(done).not.toMatch(/admin\.abuse\.|access_restricted|spam_or_seo/)
    const active = w.get('[data-testid="admin-report-rep_2"]')
    expect(active.find('[data-testid="admin-acknowledge"]').text()).toBe('Acknowledge')
    expect(active.find('[data-testid="admin-action"]').text()).toBe('Take action')
  })
})
