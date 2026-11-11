import { describe, expect, it } from 'vitest'
import { canDownload, decideFileAccess, decideTokenAccess, docStateOf, isShareExpired, isVisitor } from '../../../shared/utils/documents/docPermissions'
import { DOC_JWT_MAX_SECONDS, docJwtLifetimeSeconds } from '../../../server/utils/documents/docJwt'

// Share-link controlsin the decision layer: an expired public link
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

describe('share expiry — tokens', () => {
  it('a doc JWT from before the expiry no longer opens files after it', () => {
    const visitor = { userId: null, workspaceRole: null, hasValidDocJwt: true }
    expect(decideFileAccess(docStateOf(row('password-protected', future), now), visitor).outcome).toBe('allow')
    expect(decideFileAccess(docStateOf(row('password-protected', past), now), visitor).outcome).toBe('deny')
    // Members are not affected.
    expect(decideFileAccess(docStateOf(row('password-protected', past), now), { userId: 2, workspaceRole: 'viewer' }).outcome).toBe('allow')
  })

  it('a doc JWT never outlives the link', () => {
    expect(docJwtLifetimeSeconds(null, now)).toBe(DOC_JWT_MAX_SECONDS)
    expect(docJwtLifetimeSeconds(future, now)).toBe(DOC_JWT_MAX_SECONDS)
    expect(docJwtLifetimeSeconds(new Date(now.getTime() + 600_000), now)).toBe(600)
    expect(docJwtLifetimeSeconds(new Date(now.getTime() + 600_000).toISOString(), now)).toBe(600)
    expect(docJwtLifetimeSeconds(new Date(now.getTime() + 400), now)).toBe(1)
    // Already passed: only owner / members get a token at all, at full length.
    expect(docJwtLifetimeSeconds(past, now)).toBe(DOC_JWT_MAX_SECONDS)
    expect(docJwtLifetimeSeconds('not a date', now)).toBe(DOC_JWT_MAX_SECONDS)
  })
})
