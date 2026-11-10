import { describe, expect, it } from 'vitest'
import { canDownload, decideFileAccess, decideTokenAccess, docStateOf, isShareExpired, isVisitor } from '../../shared/utils/docPermissions'

// Share-link controls (WP9) in the decision layer: an expired public link
// acts as private for everyone but the owner and workspace members;
// view-only blocks downloads for visitors only.

const now = new Date('2026-11-10T12:00:00Z')
const past = new Date('2026-11-10T11:59:59Z')
const future = new Date('2026-11-11T00:00:00Z')
const row = (accessMode: 'private' | 'open-edit' | 'open-view' | 'password-protected', shareExpiresAt: Date | null) =>
  ({ ownerId: 1, workspaceId: 'ws', accessMode, ownerAccessSuspended: false, shareExpiresAt })
const visitor = { userId: 9, workspaceRole: null }
const anon = { userId: null, workspaceRole: null }
const owner = { userId: 1, workspaceRole: null }
const viewer = { userId: 5, workspaceRole: 'viewer' as const }

describe('share-link expiry', () => {
  it('public modes become private once expired — visitors refused, owner and members keep access', () => {
    for (const mode of ['open-edit', 'open-view', 'password-protected'] as const) {
      const state = docStateOf(row(mode, past), now)
      expect(state).toMatchObject({ accessMode: 'private', shareExpired: true })
      expect(decideTokenAccess(state, visitor).outcome).toBe('forbidden')
      expect(decideTokenAccess(state, anon).outcome).toBe('forbidden')
      expect(decideFileAccess(state, anon).outcome).toBe('deny')
      expect(decideTokenAccess(state, owner)).toEqual({ outcome: 'allow', readOnly: false })
      expect(decideTokenAccess(state, viewer)).toEqual({ outcome: 'allow', readOnly: true })
    }
  })

  it('before the expiry, and without one, nothing changes', () => {
    expect(docStateOf(row('open-edit', future), now)).toEqual({ ownerId: 1, workspaceId: 'ws', accessMode: 'open-edit', ownerAccessSuspended: false })
    expect(docStateOf(row('open-view', null), now).accessMode).toBe('open-view')
    // A private doc with an old expiry is just private (no "expired" message).
    expect(docStateOf(row('private', past), now).shareExpired).toBeUndefined()
  })

  it('reads ISO strings and treats the exact moment as expired', () => {
    expect(isShareExpired('2026-11-10T12:00:00Z', now)).toBe(true)
    expect(isShareExpired('2026-11-10T12:00:01Z', now)).toBe(false)
    expect(isShareExpired('not a date', now)).toBe(false)
    expect(isShareExpired(null, now)).toBe(false)
  })
})

describe('view-only links', () => {
  const state = docStateOf(row('open-view', null), now)
  it('visitors and guests may not download; the owner and members may', () => {
    expect(canDownload(state, visitor, true)).toBe(false)
    expect(canDownload(state, anon, true)).toBe(false)
    expect(canDownload(state, { userId: 7, workspaceRole: 'editor', isGuest: true }, true)).toBe(false)
    expect(canDownload(state, owner, true)).toBe(true)
    expect(canDownload(state, viewer, true)).toBe(true)
    expect(canDownload(state, visitor, false)).toBe(true)
  })

  it('a suspended owner (SSO) is a visitor', () => {
    const suspended = docStateOf({ ...row('open-view', null), ownerAccessSuspended: true }, now)
    expect(isVisitor(suspended, owner)).toBe(true)
  })
})
