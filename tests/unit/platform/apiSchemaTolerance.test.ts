import { describe, expect, it } from 'vitest'
import { aiSpendQuery, listAbuseReportsQuery, listAuditEventsQuery, updateAbuseReportBody } from '../../../shared/api/legal'
import { commentsSnapshotBody, internalActivityBody, legalDocumentQuery } from '../../../shared/api/platform'
import { acceptDpaBody, acceptOnboardingBody } from '../../../shared/api/account'
import { updateSsoSettingsBody, discoverSsoBody, scimUserParams, listScimUsersQuery, scimResourceBody } from '../../../shared/api/sso'
import { createDocFromTemplateBody } from '../../../shared/api/brand'
import { setMemberLimitBody } from '../../../shared/api/billing'
import { inviteMemberBody, workspaceMemberParams } from '../../../shared/api/workspaces'
import { PG_INTEGER_MAX, serialId } from '../../../shared/api/ids'

// Request schemas that must tolerate what the routes always tolerated (a
// wrongly typed optional field falls back to a default instead of a 400),
// and bound what reaches SQL.

describe('pagination and ids', () => {
  it('abuse-report limit: default 50, clamped to 1–100, never negative or fractional', () => {
    const limit = (v: unknown) => listAbuseReportsQuery.parse({ limit: v }).limit
    expect(limit(undefined)).toBe(50)
    expect(limit('abc')).toBe(50)
    expect(limit('-5')).toBe(1)
    expect(limit('0')).toBe(1)
    expect(limit('2.7')).toBe(2)
    expect(limit('500')).toBe(100)
    expect(limit('20')).toBe(20)
  })

  it('serial ids stop at the Postgres integer range; the audit cursor is clamped', () => {
    expect(serialId.safeParse(String(PG_INTEGER_MAX)).success).toBe(true)
    expect(serialId.safeParse(String(PG_INTEGER_MAX + 1)).success).toBe(false)
    expect(serialId.safeParse('1e20').success).toBe(false)
    expect(workspaceMemberParams.safeParse({ wsId: 'w', userId: '99999999999' }).success).toBe(false)
    expect(scimUserParams.safeParse({ id: '99999999999' }).success).toBe(false)
    expect(listAuditEventsQuery.parse({ before: '99999999999' }).before).toBe(PG_INTEGER_MAX)
  })
})

describe('fallbacks instead of 400s', () => {
  it('a repeated or non-text legal locale falls back (the handler picks English)', () => {
    expect(legalDocumentQuery.parse({ locale: ['de', 'fr'] }).locale).toBeUndefined()
    expect(legalDocumentQuery.parse({ locale: 'de' }).locale).toBe('de')
  })

  it('admin AI spend range: only a real calendar day is kept, anything else is the default window', () => {
    expect(aiSpendQuery.parse({ from: '2026-02-28', to: '2024-02-29' })).toEqual({ from: '2026-02-28', to: '2024-02-29' })
    // Right shape, impossible day: LiteLLM answers 400 to these.
    expect(aiSpendQuery.parse({ from: '2026-13-01', to: '2026-02-29' })).toEqual({ from: undefined, to: undefined })
    expect(aiSpendQuery.parse({ from: '2026-1-1', to: ['2026-01-01', '2026-01-02'] })).toEqual({ from: undefined, to: undefined })
  })

  it('a non-text locale on onboarding / DPA acceptance falls back', () => {
    expect(acceptOnboardingBody.parse({ ageConfirmed: true, privacyVersion: 1, tosVersion: 1, locale: 5 }).locale).toBeNull()
    expect(acceptDpaBody.parse({ dpaVersion: 1, locale: { x: 1 } }).locale).toBeNull()
    expect(acceptDpaBody.parse({ dpaVersion: 1, locale: 'fr' }).locale).toBe('fr')
  })

  it('abuse-report PATCH: a decision that is not an object is no decision', () => {
    expect(updateAbuseReportBody.parse({ status: 'acknowledged', decision: 'x' }).decision).toBeNull()
    expect(updateAbuseReportBody.parse({ status: 'actioned', decision: 5 }).decision).toBeNull()
    expect(updateAbuseReportBody.safeParse({ status: 'nope' }).success).toBe(false)
  })

  it('internal activity: a wrongly typed counter or metadata drops the field, not the row', () => {
    const parsed = internalActivityBody.parse({ docId: 'd', action: 'edit', wordCount: '12', linesAdded: 'x', linesRemoved: {}, metadata: 'oops' })
    expect(parsed).toMatchObject({ docId: 'd', action: 'edit', wordCount: null, linesAdded: null, linesRemoved: null, metadata: null })
    expect(internalActivityBody.parse({ docId: 'd', action: 'edit', wordCount: 3, metadata: { a: 1 } })).toMatchObject({ wordCount: 3, metadata: null })
    expect(internalActivityBody.parse({ docId: 'd', action: 'theme.changed', metadata: { kind: 'theme.changed' } }).metadata).toEqual({ kind: 'theme.changed' })
  })

  it('SSO settings: null / non-text fields read as absent (a null secret keeps the stored one)', () => {
    const parsed = updateSsoSettingsBody.parse({ protocol: 'oidc', oidcIssuer: 'https://idp', oidcClientId: 'c', oidcClientSecret: null, samlIdpCert: 42 })
    expect(parsed).toMatchObject({ oidcIssuer: 'https://idp', oidcClientId: 'c' })
    expect(parsed.oidcClientSecret).toBeNull()
    expect(parsed.samlIdpCert).toBeUndefined()
    expect(updateSsoSettingsBody.safeParse({ protocol: 'ldap' }).success).toBe(false)
  })

  it('new document from a template: a non-text title is the template name; too long is still refused', () => {
    expect(createDocFromTemplateBody.parse({ title: null })?.title).toBeUndefined()
    expect(createDocFromTemplateBody.parse({ title: 7 })?.title).toBeUndefined()
    expect(createDocFromTemplateBody.parse({ title: '  Q3 plan ' })?.title).toBe('Q3 plan')
    expect(createDocFromTemplateBody.safeParse({ title: 'x'.repeat(10_000) }).success).toBe(false)
  })

  it('member AI limit: wrongly typed fields reach the handler as absent (its own 400 with the maximum)', () => {
    expect(setMemberLimitBody.parse({ limitUsd: 'ten' })).toEqual({ limitUsd: undefined })
    expect(setMemberLimitBody.parse({ default: 'yes' })).toEqual({ default: undefined })
    expect(setMemberLimitBody.parse({ limitUsd: null })).toEqual({ limitUsd: null })
  })

  it('invite: a missing or non-text address reaches the handler (workspace/invalid-email)', () => {
    expect(inviteMemberBody.parse({}).email).toBeUndefined()
    expect(inviteMemberBody.parse({ email: 5 }).email).toBeUndefined()
    expect(inviteMemberBody.parse({ email: 'a@b.test' }).email).toBe('a@b.test')
  })

  it('SSO discovery never refuses a body', () => {
    for (const body of [null, 'x', [1], { email: 5 }]) expect(discoverSsoBody.safeParse(body).success).toBe(true)
  })
})

describe('refusals that stay', () => {
  it('a comments snapshot entry must be an object', () => {
    expect(commentsSnapshotBody.safeParse({ docId: 'd', entries: [null] }).success).toBe(false)
    expect(commentsSnapshotBody.safeParse({ docId: 'd', entries: [{}] }).success).toBe(true)
  })

  it('SCIM: any JSON object as a body; junk paging values fall back to the defaults', () => {
    expect(scimResourceBody.safeParse([1]).success).toBe(false)
    expect(scimResourceBody.safeParse({ Operations: [] }).success).toBe(true)
    expect(listScimUsersQuery.parse({ startIndex: 'abc', count: '-5' })).toMatchObject({ startIndex: 1, count: 0 })
    expect(listScimUsersQuery.parse({})).toMatchObject({ startIndex: 1, count: 100 })
  })
})
