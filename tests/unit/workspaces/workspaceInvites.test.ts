import { describe, it, expect } from 'vitest'
import en from '../../../i18n/locales/en.json'
import de from '../../../i18n/locales/de.json'
import fr from '../../../i18n/locales/fr.json'
import es from '../../../i18n/locales/es.json'
import ja from '../../../i18n/locales/ja.json'
import zh from '../../../i18n/locales/zh.json'
import {
  INVITE_EMAIL_LOCALES,
  buildWorkspaceInviteEmail,
  generateInviteToken,
  hashInviteSecret,
  isInviteRole,
  normaliseInviteEmail,
  normaliseInviteLocale,
  parseInviteId,
  parseInviteToken
} from '../../../server/utils/workspaces/workspaceInvites'

describe('workspace invite helpers', () => {
  it('normalises addresses (trim + lower-case) and rejects implausible ones', () => {
    expect(normaliseInviteEmail('  Alice@Example.COM ')).toBe('alice@example.com')
    expect(normaliseInviteEmail('not-an-email')).toBeNull()
    expect(normaliseInviteEmail(42)).toBeNull()
    expect(normaliseInviteEmail(`${'a'.repeat(250)}@x.io`)).toBeNull()
  })

  it('accepts only the three roles', () => {
    expect(isInviteRole('admin')).toBe(true)
    expect(isInviteRole('editor')).toBe(true)
    expect(isInviteRole('viewer')).toBe(true)
    expect(isInviteRole('owner')).toBe(false)
    expect(isInviteRole(undefined)).toBe(false)
  })

  it('mints 256-bit tokens that parse, and hashes them', () => {
    const token = generateInviteToken()
    expect(token).toHaveLength(43)
    expect(parseInviteToken(token)).toBe(token)
    expect(hashInviteSecret(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashInviteSecret(token)).not.toBe(token)
    expect(parseInviteToken('short')).toBeNull()
    expect(parseInviteToken('has spaces in it, definitely too')).toBeNull()
  })

  it('parses invite ids from route params', () => {
    expect(parseInviteId('AbCdEfGh12345678')).toBe('AbCdEfGh12345678')
    expect(parseInviteId('../etc')).toBeNull()
    expect(parseInviteId(undefined)).toBeNull()
  })

  it('falls back to English for unknown locales', () => {
    expect(normaliseInviteLocale('de')).toBe('de')
    expect(normaliseInviteLocale('xx')).toBe('en')
    expect(normaliseInviteLocale(null)).toBe('en')
  })
})

describe('buildWorkspaceInviteEmail', () => {
  it('links to the accept page on the configured origin with the token', () => {
    const { subject, body } = buildWorkspaceInviteEmail({
      locale: 'en',
      baseUrl: 'https://markoto.example/',
      token: 'tok_abcdefghijklmnopqrstuvwxyz',
      inviterName: 'Maya',
      workspaceName: 'Q3 launch',
      role: 'editor'
    })
    expect(subject).toContain('Q3 launch')
    expect(body).toContain('https://markoto.example/invites/accept?token=tok_abcdefghijklmnopqrstuvwxyz')
    expect(body).toContain('Maya')
    expect(body).toContain('an editor')
  })

  it('clips and flattens user-supplied names', () => {
    const { subject, body } = buildWorkspaceInviteEmail({
      locale: 'en',
      baseUrl: 'https://markoto.example',
      token: 'tok_abcdefghijklmnopqrstuvwxyz',
      inviterName: 'Eve\nClick here: https://evil.example',
      workspaceName: 'x'.repeat(200),
      role: 'viewer'
    })
    expect(subject.length).toBeLessThan(200)
    expect(body.split('\n')[0]).toContain('Eve Click here')
  })

  it('has copy for every locale', () => {
    for (const locale of INVITE_EMAIL_LOCALES) {
      const { subject, body } = buildWorkspaceInviteEmail({
        locale,
        baseUrl: 'https://markoto.example',
        token: 'tok_abcdefghijklmnopqrstuvwxyz',
        inviterName: 'Maya',
        workspaceName: 'Space',
        role: 'admin'
      })
      expect(subject).toContain('Space')
      expect(body).toContain('/invites/accept?token=')
    }
  })
})

// Invite / session UI strings: every key used by the members modal, the
// dashboard invitations, the accept page and the profile "Sessions"
// section must exist in all six locales.
const LOCALES: Record<string, unknown> = { en, de, fr, es, ja, zh }

function resolve(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, seg) => {
    if (acc && typeof acc === 'object' && seg in acc) {
      return (acc as Record<string, unknown>)[seg]
    }
    return undefined
  }, obj)
}

const UI_KEYS = [
  'auth.reauthTitle',
  'auth.reauthAction',
  'workspace.members.addTitle',
  'workspace.members.addHint',
  'workspace.members.add',
  'workspace.members.addFailed',
  'workspace.members.invitedToast',
  'workspace.members.invitedToastDescription',
  'workspace.members.pendingTitle',
  'workspace.members.pendingExpires',
  'workspace.members.revoke',
  'workspace.members.revokeFailed',
  'workspace.invites.sectionTitle',
  'workspace.invites.invitedBy',
  'workspace.invites.invitedAs',
  'workspace.invites.accept',
  'workspace.invites.decline',
  'workspace.invites.accepted',
  'workspace.invites.acceptFailed',
  'workspace.invites.declineFailed',
  'workspace.invites.page.title',
  'workspace.invites.page.intro',
  'workspace.invites.page.signIn',
  'workspace.invites.page.accept',
  'workspace.invites.page.declined',
  'workspace.invites.page.missingToken',
  'workspace.invites.page.home',
  'settings.profile.sessions.heading',
  'settings.profile.sessions.description',
  'settings.profile.sessions.button',
  'settings.profile.sessions.failed'
]

describe('invite + session i18n keys', () => {
  for (const [locale, messages] of Object.entries(LOCALES)) {
    it(`${locale} has every key`, () => {
      for (const key of UI_KEYS) {
        const value = resolve(messages, key)
        expect(typeof value === 'string' && value.length > 0, `${locale}: ${key}`).toBe(true)
      }
    })
  }
})
