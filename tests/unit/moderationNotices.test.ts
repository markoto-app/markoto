import { describe, it, expect } from 'vitest'
import {
  MODERATION_ACTIONS,
  MODERATION_RULES,
  REPORT_CATEGORIES,
  actionRestrictsContent,
  contactOptionalFor,
  docIdFromReportedLocation,
  isModerationAction,
  isModerationRule,
  isReportCategory
} from '../../shared/config/moderation'
import { NOTICE_COPY, NOTICE_LOCALES, normaliseNoticeLocale } from '../../server/utils/moderationNoticeCopy'
import { buildDecisionNotice, buildReceiptNotice, buildStatementOfReasons } from '../../server/utils/moderationNotices'

// DSA notice-and-action vocabulary + the three notice texts
// (receipt Art.16(4), decision Art.16(5), statement of reasons Art.17).

describe('docIdFromReportedLocation', () => {
  it('reads the id out of a document URL or path', () => {
    expect(docIdFromReportedLocation('https://markoto.app/d/AbC_123-x')).toBe('AbC_123-x')
    expect(docIdFromReportedLocation('markoto.app/d/abc?x=1')).toBe('abc')
    expect(docIdFromReportedLocation('/d/abc#section')).toBe('abc')
    expect(docIdFromReportedLocation('  abc123  ')).toBe('abc123')
  })
  it('returns null for anything else', () => {
    expect(docIdFromReportedLocation('')).toBeNull()
    expect(docIdFromReportedLocation('https://example.com/some/page')).toBeNull()
    expect(docIdFromReportedLocation('the whole site is spam')).toBeNull()
  })
})

describe('vocabulary', () => {
  it('type guards match the lists', () => {
    for (const c of REPORT_CATEGORIES) expect(isReportCategory(c)).toBe(true)
    for (const r of MODERATION_RULES) expect(isModerationRule(r)).toBe(true)
    for (const a of MODERATION_ACTIONS) expect(isModerationAction(a)).toBe(true)
    expect(isReportCategory('nope')).toBe(false)
    expect(isModerationRule(undefined)).toBe(false)
  })
  it('contact data is optional only for CSAM reports (Art.16(2)(c))', () => {
    expect(REPORT_CATEGORIES.filter(contactOptionalFor)).toEqual(['csam'])
  })
  it('removal and restriction owe a statement of reasons, no action does not', () => {
    expect(MODERATION_ACTIONS.filter(actionRestrictsContent)).toEqual(['content_removed', 'access_restricted'])
  })
})

describe('notice copy', () => {
  it('every locale names every rule and action', () => {
    for (const locale of NOTICE_LOCALES) {
      for (const rule of MODERATION_RULES) expect(NOTICE_COPY[locale].rules[rule], `${locale}:${rule}`).toBeTruthy()
      for (const action of MODERATION_ACTIONS) expect(NOTICE_COPY[locale].actions[action], `${locale}:${action}`).toBeTruthy()
    }
  })
  it('normalises locales (region tags, unknown → en)', () => {
    expect(normaliseNoticeLocale('de-CH')).toBe('de')
    expect(normaliseNoticeLocale('ZH')).toBe('zh')
    expect(normaliseNoticeLocale('it')).toBe('en')
    expect(normaliseNoticeLocale(null)).toBe('en')
  })
})

describe('buildReceiptNotice', () => {
  it('quotes the reference and the reported location', () => {
    const n = buildReceiptNotice('en', { reportId: 'rep-1', contentUrl: 'https://markoto.app/d/x' })
    expect(n.subject).toContain('rep-1')
    expect(n.body).toContain('rep-1')
    expect(n.body).toContain('https://markoto.app/d/x')
  })
})

describe('buildDecisionNotice', () => {
  it('states the action, the rule and the reasons', () => {
    const n = buildDecisionNotice('en', {
      reportId: 'rep-2',
      contentUrl: 'https://markoto.app/d/x',
      action: 'content_removed',
      rule: 'phishing_or_fraud',
      explanation: 'The page imitated a bank login form.'
    })
    expect(n.body).toContain('The document was removed.')
    expect(n.body).toContain('Phishing, scams or fraud')
    expect(n.body).toContain('imitated a bank login form')
  })
  it('a dismissal names no rule', () => {
    const n = buildDecisionNotice('de', { reportId: 'r', contentUrl: null, action: 'no_action', rule: null, explanation: 'Kein Verstoss erkennbar.' })
    expect(n.body).toContain('nichts unternommen')
    expect(n.body).not.toContain('Regel:')
  })
})

describe('buildStatementOfReasons (DSA Art.17(3))', () => {
  const input = {
    reportId: 'rep-3',
    documentUrl: 'https://markoto.app/d/abc',
    documentTitle: 'Totally a bank',
    action: 'access_restricted' as const,
    rule: 'phishing_or_fraud' as const,
    explanation: 'Login form collecting bank credentials.',
    decidedAt: new Date(Date.UTC(2026, 10, 3)),
    contact: 'abuse@example.org'
  }

  it('contains every Art.17(3) element', () => {
    const { body } = buildStatementOfReasons('en', input)
    expect(body).toContain('Access to the document was restricted') // (a) what was done
    expect(body).toContain('worldwide') // (a) territorial scope
    expect(body).toContain('based on a report') // (b) notice-based
    expect(body).toContain('A person reviewed') // (c) no automated means
    expect(body).toContain('Phishing, scams or fraud') // (d/e) ground
    expect(body).toContain('Login form collecting bank credentials.') // facts
    expect(body).toContain('abuse@example.org') // (f) redress: internal complaint
    expect(body).toContain('out-of-court') // (f) redress: ODS + court
    expect(body).toContain('2026-11-03')
    expect(body).toContain('rep-3')
  })

  it('falls back to a generic redress line without a contact address', () => {
    const { body } = buildStatementOfReasons('en', { ...input, contact: null })
    expect(body).toContain('contact the operator of this service')
  })

  it('is localised for every notice locale', () => {
    const bodies = NOTICE_LOCALES.map(l => buildStatementOfReasons(l, input).body)
    expect(new Set(bodies).size).toBe(NOTICE_LOCALES.length)
    for (const body of bodies) expect(body).toContain('abuse@example.org')
  })
})
