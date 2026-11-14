import { describe, expect, it } from 'vitest'
import { buildDataExportReadyEmail } from '../../../server/utils/email/dataExportEmail'
import { INVITE_EMAIL_LOCALES } from '../../../server/utils/workspaces/workspaceInvites'

// The "export ready" mail: in the account's language, with the full
// address of the profile page (a bare path is no link in a mail client).

describe('buildDataExportReadyEmail', () => {
  it('puts the absolute profile address on its own line', () => {
    const { body } = buildDataExportReadyEmail('en', 'https://markoto.example', 7)
    expect(body.split('\n')).toContain('https://markoto.example/settings/profile')
    expect(body).not.toMatch(/(^|\s)\/settings\/profile/)
    expect(body).toContain('7 days')
  })

  it('is written in the account\'s language', () => {
    const de = buildDataExportReadyEmail('de', 'https://markoto.example', 7)
    expect(de.subject).toBe('Dein markoto-Datenexport ist bereit')
    expect(de.body).toContain('Melde dich an')
    expect(de.body).toContain('7 Tage')
  })

  it('has a text for every locale, each with the link', () => {
    const subjects = new Set<string>()
    for (const locale of INVITE_EMAIL_LOCALES) {
      const { subject, body } = buildDataExportReadyEmail(locale, 'https://markoto.example', 7)
      subjects.add(subject)
      expect(body).toContain('https://markoto.example/settings/profile')
      expect(body).toContain('7')
    }
    expect(subjects.size).toBe(INVITE_EMAIL_LOCALES.length)
  })

  it('names the page instead of a broken link when no site URL is configured', () => {
    const { body } = buildDataExportReadyEmail('en', null, 7)
    expect(body).not.toContain('/settings/profile')
    expect(body).toContain('Settings → Profile')
  })
})
