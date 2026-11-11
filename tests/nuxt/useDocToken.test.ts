import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'

// Explicit import — the composable auto-imports `useUserSession` and `ref`,
// both of which the nuxt environment resolves at transform time.
import { useDocToken } from '~/composables/document/useDocToken'

// Composable under test: owns the auth/access-mode side of a document.
// See app/composables/document/useDocToken.ts for the contract we're pinning here.
//
// The composable has two external dependencies:
//   1. `useUserSession()` from nuxt-auth-utils — we need the `user` ref
//      to drive the `isOwner` derivation. Mocked via `mockNuxtImport`.
//   2. `$fetch('/api/docs/:id/token')` — real fetch through Nitro; stubbed
//      with `registerEndpoint` so we exercise the full `$fetch` path
//      (errors flow through the catch branch like in production).

// Hoisted so the mockNuxtImport factory (which itself is hoisted above
// imports) can close over the same ref. Flipping `.value` between tests
// controls what the composable sees as the logged-in user.
const { sessionUser } = vi.hoisted(() => ({
  sessionUser: { value: null as { id: number } | null }
}))

mockNuxtImport('useUserSession', () => {
  return () => ({ user: sessionUser })
})

// Per-test response holder. Each endpoint-handler reads from `.current`
// at request time, so tests can rewrite the response between calls
// without re-registering the endpoint.
interface TokenPayload {
  token: string | null
  readOnly: boolean
  requiresPassword?: boolean
  forbidden?: boolean
  accessMode: string
  ownerId: number | null
  theme?: unknown
  title?: string
  canDelete?: boolean
  noDownload?: boolean
  shareExpired?: boolean
}

const response: { current: TokenPayload | Error } = {
  current: {
    token: '', readOnly: false, accessMode: 'open-edit', ownerId: null
  }
}

registerEndpoint('/api/docs/doc-123/token', () => {
  if (response.current instanceof Error) throw response.current
  return response.current
})

beforeEach(() => {
  sessionUser.value = null
  response.current = {
    token: '', readOnly: false, accessMode: 'open-edit', ownerId: null
  }
})

describe('useDocToken — fetchToken happy path', () => {
  it('populates tokenData and flags from a standard open-edit response', async () => {
    response.current = {
      token: 'jwt-abc',
      readOnly: false,
      accessMode: 'open-edit',
      ownerId: null,
      theme: null
    }

    const t = useDocToken('doc-123')
    await t.fetchToken()

    expect(t.tokenData.value).toEqual({ token: 'jwt-abc', readOnly: false })
    expect(t.isReadOnly.value).toBe(false)
    expect(t.accessMode.value).toBe('open-edit')
    expect(t.requiresPassword.value).toBe(false)
    expect(t.forbidden.value).toBe(false)
    expect(t.hasOwner.value).toBe(false)
    expect(t.isOwner.value).toBe(false)
    expect(t.initialTheme.value).toBe(null)
  })

  it('propagates the server readOnly flag into both the ref and tokenData', async () => {
    response.current = {
      token: 'jwt-ro',
      readOnly: true,
      accessMode: 'open-view',
      ownerId: 7,
      theme: null
    }

    const t = useDocToken('doc-123')
    await t.fetchToken()

    expect(t.isReadOnly.value).toBe(true)
    expect(t.tokenData.value?.readOnly).toBe(true)
  })

  it('seeds initialTheme when the server includes one on the token payload', async () => {
    const theme = { fontFamily: 'serif', baseFontSize: 14 }
    response.current = {
      token: 'jwt',
      readOnly: false,
      accessMode: 'open-edit',
      ownerId: null,
      theme
    }

    const t = useDocToken('doc-123')
    await t.fetchToken()

    expect(t.initialTheme.value).toEqual(theme)
  })

  it('leaves initialTheme null when the server omits theme', async () => {
    response.current = {
      token: 'jwt',
      readOnly: false,
      accessMode: 'open-edit',
      ownerId: null
      // no theme key
    }

    const t = useDocToken('doc-123')
    await t.fetchToken()

    expect(t.initialTheme.value).toBe(null)
  })
})

describe('useDocToken — isOwner / hasOwner derivation', () => {
  it('isOwner is true when ownerId matches the logged-in user id', async () => {
    sessionUser.value = { id: 42 }
    response.current = {
      token: 'jwt', readOnly: false, accessMode: 'private',
      ownerId: 42, theme: null
    }

    const t = useDocToken('doc-123')
    await t.fetchToken()

    expect(t.isOwner.value).toBe(true)
    expect(t.hasOwner.value).toBe(true)
  })

  it('isOwner is false when logged-in user is a different owner', async () => {
    sessionUser.value = { id: 7 }
    response.current = {
      token: 'jwt', readOnly: true, accessMode: 'open-view',
      ownerId: 42, theme: null
    }

    const t = useDocToken('doc-123')
    await t.fetchToken()

    expect(t.isOwner.value).toBe(false)
    expect(t.hasOwner.value).toBe(true)
  })

  it('isOwner is false for an anonymous visitor even when the doc has an owner', async () => {
    sessionUser.value = null
    response.current = {
      token: 'jwt', readOnly: true, accessMode: 'open-view',
      ownerId: 42, theme: null
    }

    const t = useDocToken('doc-123')
    await t.fetchToken()

    expect(t.isOwner.value).toBe(false)
    expect(t.hasOwner.value).toBe(true)
  })

  it('hasOwner and isOwner are both false for anonymous-created docs (ownerId null)', async () => {
    // Anonymous-created doc: even a logged-in viewer isn't the owner,
    // and the "anyone can edit theme" rule kicks in downstream (see
    // useDocument.ts canEditTheme derivation).
    sessionUser.value = { id: 1 }
    response.current = {
      token: 'jwt', readOnly: false, accessMode: 'open-edit',
      ownerId: null, theme: null
    }

    const t = useDocToken('doc-123')
    await t.fetchToken()

    expect(t.hasOwner.value).toBe(false)
    expect(t.isOwner.value).toBe(false)
  })
})

describe('useDocToken — password-protected path', () => {
  it('surfaces requiresPassword and zeroes the JWT so the provider cannot connect', async () => {
    // Server returns `token: null` for password-protected docs (see the
    // token endpoint). That null must flatten to empty string client-side
    // so provider code can compare on falsiness without undefined checks.
    response.current = {
      token: null,
      readOnly: false,
      requiresPassword: true,
      accessMode: 'password-protected',
      ownerId: 3,
      theme: null
    }

    const t = useDocToken('doc-123')
    await t.fetchToken()

    expect(t.tokenData.value).toEqual({ token: '', readOnly: false })
    expect(t.requiresPassword.value).toBe(true)
    expect(t.forbidden.value).toBe(false)
  })
})

describe('useDocToken — forbidden path (private, non-owner)', () => {
  it('surfaces forbidden and zeroes the JWT', async () => {
    response.current = {
      token: null,
      readOnly: false,
      forbidden: true,
      accessMode: 'private',
      ownerId: 3,
      theme: null
    }

    const t = useDocToken('doc-123')
    await t.fetchToken()

    expect(t.tokenData.value).toEqual({ token: '', readOnly: false })
    expect(t.forbidden.value).toBe(true)
    expect(t.requiresPassword.value).toBe(false)
  })
})

describe('useDocToken — network / 4xx failure', () => {
  it('swallows the error and falls through to an empty-token state', async () => {
    // If the token endpoint throws (network blip, 404, 403), the UI
    // should render the disconnected state — not crash. No flags get
    // set so the editor layout renders a plain "disconnected" header
    // rather than a misleading "private" or "password" gate.
    response.current = new Error('network')

    const t = useDocToken('doc-123')
    await t.fetchToken()

    expect(t.tokenData.value).toEqual({ token: '', readOnly: false })
    expect(t.requiresPassword.value).toBe(false)
    expect(t.forbidden.value).toBe(false)
    // A non-404 error is a transient disconnect, NOT a missing doc — the
    // not-found screen must not fire on a network blip.
    expect(t.notFound.value).toBe(false)
  })

  it('flags notFound on a genuine 404 (doc does not exist)', async () => {
    // An unstubbed docId makes Nitro return a real 404, exercising the
    // exact status the token endpoint throws for a nonexistent doc. The
    // catch branch must flip `notFound` so the editor renders the
    // not-found screen instead of a misleading "disconnected" dead end.
    const t = useDocToken('unregistered-id')
    await t.fetchToken()

    expect(t.tokenData.value).toEqual({ token: '', readOnly: false })
    expect(t.notFound.value).toBe(true)
    expect(t.forbidden.value).toBe(false)
  })
})

describe('useDocToken — onPasswordVerified / clearPendingUnlock', () => {
  it('onPasswordVerified stashes the new token and raises pendingUnlock', async () => {
    response.current = {
      token: null,
      readOnly: false,
      requiresPassword: true,
      accessMode: 'password-protected',
      ownerId: 3,
      theme: null
    }

    const t = useDocToken('doc-123')
    await t.fetchToken()
    t.onPasswordVerified('fresh-jwt')

    expect(t.pendingPasswordUnlock.value).toBe(true)
    expect(t.tokenData.value).toEqual({ token: 'fresh-jwt', readOnly: false })
    expect(t.isReadOnly.value).toBe(false)
    // requiresPassword must stay true until the post-reconnect sync
    // fires `clearPendingUnlock()`. Flipping it early causes the
    // empty-doc-prepend bug called out in useDocToken.ts.
    expect(t.requiresPassword.value).toBe(true)
  })

  it('clearPendingUnlock flips both flags off once pendingUnlock was set', () => {
    const t = useDocToken('doc-123')

    // Simulate mid-unlock state directly rather than going through the
    // whole password flow — we're pinning the helper's logic here.
    t.requiresPassword.value = true
    t.pendingPasswordUnlock.value = true

    t.clearPendingUnlock()

    expect(t.pendingPasswordUnlock.value).toBe(false)
    expect(t.requiresPassword.value).toBe(false)
  })

  it('clearPendingUnlock is a no-op when pendingUnlock was never set', () => {
    // Defends against stray calls from the orchestrator accidentally
    // toggling requiresPassword off when the user is still gated.
    const t = useDocToken('doc-123')
    t.requiresPassword.value = true

    t.clearPendingUnlock()

    expect(t.requiresPassword.value).toBe(true)
    expect(t.pendingPasswordUnlock.value).toBe(false)
  })
})

describe('useDocToken — imperative actions', () => {
  it('markReadOnly flips isReadOnly to true', () => {
    // Called by the sync layer on `onAuthenticationFailed` — e.g. if
    // the server rotates the access mode from edit to view mid-session.
    const t = useDocToken('doc-123')
    expect(t.isReadOnly.value).toBe(false)

    t.markReadOnly()

    expect(t.isReadOnly.value).toBe(true)
  })

  it('setAccessMode updates the accessMode ref', () => {
    // ShareModal calls this when the owner picks a new mode — drives
    // UI copy instantly while the PUT /meta is in flight.
    const t = useDocToken('doc-123')

    t.setAccessMode('password-protected')

    expect(t.accessMode.value).toBe('password-protected')
  })
})

describe('useDocToken — independence between instances', () => {
  it('two useDocToken calls produce independent reactive state', () => {
    // Guard against accidental module-level refs that would leak
    // state across doc navigations.
    const a = useDocToken('doc-123')
    const b = useDocToken('doc-123')

    a.markReadOnly()

    expect(a.isReadOnly.value).toBe(true)
    expect(b.isReadOnly.value).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// getFreshToken — F5 token refresh on reconnect
// ═══════════════════════════════════════════════════════════════════════

// Build a syntactically-real JWT (header.payload.sig) whose payload
// carries an `exp` claim `expSecondsFromNow` in the future (negative =
// already expired). `marker` makes otherwise-identical tokens distinct
// so tests can tell a reused token from a refetched one.
function makeJwt(expSecondsFromNow: number, marker: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const payload = b64({
    docId: 'doc-123',
    marker,
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow
  })
  return `${head}.${payload}.sig`
}

describe('useDocToken — getFreshToken (F5)', () => {
  it('reuses the current token while it is comfortably valid (no refetch)', async () => {
    response.current = { token: makeJwt(3600, 'valid'), readOnly: false, accessMode: 'open-edit', ownerId: null }
    const t = useDocToken('doc-123')
    await t.fetchToken()
    const original = t.tokenData.value!.token

    // If getFreshToken wrongly refetched, it would return THIS token.
    response.current = { token: makeJwt(3600, 'unwanted-refetch'), readOnly: false, accessMode: 'open-edit', ownerId: null }
    const fresh = await t.getFreshToken()

    expect(fresh).toBe(original)
    expect(t.tokenData.value!.token).toBe(original)
  })

  it('refetches a fresh JWT when the current one is near/at expiry', async () => {
    response.current = { token: makeJwt(30, 'expiring'), readOnly: false, accessMode: 'open-edit', ownerId: null }
    const t = useDocToken('doc-123')
    await t.fetchToken()

    const newToken = makeJwt(7200, 'refetched')
    response.current = { token: newToken, readOnly: false, accessMode: 'open-edit', ownerId: null }
    const fresh = await t.getFreshToken()

    expect(fresh).toBe(newToken)
    expect(t.tokenData.value!.token).toBe(newToken)
  })

  it('treats an expired token as needing refresh', async () => {
    response.current = { token: makeJwt(-10, 'dead'), readOnly: false, accessMode: 'open-edit', ownerId: null }
    const t = useDocToken('doc-123')
    await t.fetchToken()

    const newToken = makeJwt(7200, 'revived')
    response.current = { token: newToken, readOnly: false, accessMode: 'open-edit', ownerId: null }
    expect(await t.getFreshToken()).toBe(newToken)
  })

  it('keeps the existing token when a refresh yields no usable token (password-gated / null)', async () => {
    response.current = { token: makeJwt(30, 'pw-owner'), readOnly: false, accessMode: 'password-protected', ownerId: null }
    const t = useDocToken('doc-123')
    await t.fetchToken()
    const original = t.tokenData.value!.token

    // A non-owner password doc returns token:null from /token — must NOT
    // clobber the (still-present) token to empty.
    response.current = { token: null, readOnly: false, accessMode: 'password-protected', ownerId: 1 }
    const fresh = await t.getFreshToken()

    expect(fresh).toBe(original)
    expect(t.tokenData.value!.token).toBe(original)
  })

  it('falls back to the current token when the refetch request errors', async () => {
    response.current = { token: makeJwt(30, 'expiring'), readOnly: false, accessMode: 'open-edit', ownerId: null }
    const t = useDocToken('doc-123')
    await t.fetchToken()
    const original = t.tokenData.value!.token

    response.current = new Error('network down')
    expect(await t.getFreshToken()).toBe(original)
  })

  it('returns empty string when there is no token to refresh (forbidden / pre-fetch)', async () => {
    const t = useDocToken('doc-123')
    expect(await t.getFreshToken()).toBe('')
  })
})

// The sync server asks for a fresh token before expiry (renewal) and closes
// connections whose access must be re-checked (invalidateToken). Either way
// the token is refetched even though it still looks valid, and a refetch
// that finds access ended flips to the same gate a page load would show.
describe('useDocToken — renewal and re-authentication', () => {
  it('a renewal refetches even a comfortably valid token', async () => {
    response.current = { token: makeJwt(3600, 'valid'), readOnly: false, accessMode: 'open-edit', ownerId: null }
    const t = useDocToken('doc-123')
    await t.fetchToken()
    const renewed = makeJwt(7200, 'renewed')
    response.current = { token: renewed, readOnly: true, accessMode: 'open-view', ownerId: null, noDownload: true }
    expect(await t.getFreshToken({ renewal: true })).toBe(renewed)
    expect(t.isReadOnly.value).toBe(true)
    expect(t.noDownload.value).toBe(true)
  })

  it('invalidateToken makes the next connect refetch, once', async () => {
    response.current = { token: makeJwt(3600, 'valid'), readOnly: false, accessMode: 'open-edit', ownerId: null }
    const t = useDocToken('doc-123')
    await t.fetchToken()
    t.invalidateToken()
    const fresh = makeJwt(7200, 'fresh')
    response.current = { token: fresh, readOnly: false, accessMode: 'open-edit', ownerId: null }
    expect(await t.getFreshToken()).toBe(fresh)
    response.current = { token: makeJwt(7200, 'unwanted'), readOnly: false, accessMode: 'open-edit', ownerId: null }
    expect(await t.getFreshToken()).toBe(fresh)
  })

  it('access ended (made private / link expired): forbidden gate, no token handed out', async () => {
    response.current = { token: makeJwt(3600, 'visitor'), readOnly: false, accessMode: 'open-edit', ownerId: null }
    const t = useDocToken('doc-123')
    await t.fetchToken()
    t.invalidateToken()
    response.current = { token: null, readOnly: true, forbidden: true, shareExpired: true, accessMode: 'private', ownerId: null }
    expect(await t.getFreshToken()).toBe('')
    expect(t.forbidden.value).toBe(true)
    expect(t.shareExpired.value).toBe(true)
    expect(t.isReadOnly.value).toBe(true)
  })

  it('a password set while a visitor was in: back to the password prompt', async () => {
    response.current = { token: makeJwt(3600, 'visitor'), readOnly: false, accessMode: 'open-edit', ownerId: null }
    const t = useDocToken('doc-123')
    await t.fetchToken()
    response.current = { token: null, readOnly: true, requiresPassword: true, accessMode: 'password-protected', ownerId: null }
    expect(await t.getFreshToken({ renewal: true })).toBe('')
    expect(t.requiresPassword.value).toBe(true)
    expect(t.forbidden.value).toBe(false)
  })
})

// After a password unlock the gated /token response carried no metadata;
// `hydrateAfterUnlock` fetches it from /meta with the unlock JWT.
const metaCalls: Array<{ authorization: string | undefined }> = []
registerEndpoint('/api/docs/doc-123/meta', (event: { node: { req: { headers: Record<string, string | string[] | undefined> } } }) => {
  const auth = event.node.req.headers.authorization
  metaCalls.push({ authorization: typeof auth === 'string' ? auth : undefined })
  return {
    theme: null,
    title: 'Launch plan',
    description: 'Secret plan',
    audience: 'business',
    language: 'de',
    initialBody: '# Template'
  }
})

describe('useDocToken — hydrateAfterUnlock', () => {
  it('fetches /meta with the unlock JWT and seeds the initial refs', async () => {
    metaCalls.length = 0
    const t = useDocToken('doc-123')
    await t.hydrateAfterUnlock('unlock-jwt')

    expect(metaCalls).toEqual([{ authorization: 'Bearer unlock-jwt' }])
    expect(t.initialTitle.value).toBe('Launch plan')
    expect(t.initialDescription.value).toBe('Secret plan')
    expect(t.initialAudience.value).toBe('business')
    expect(t.initialLanguage.value).toBe('de')
    expect(t.initialBody.value).toBe('# Template')
  })
})

describe('useDocToken — initialTitle', () => {
  it('seeds the DB title from /token (shown until ymeta carries one)', async () => {
    response.current = { token: 'jwt', readOnly: false, accessMode: 'open-edit', ownerId: null, title: 'Project kickoff notes' }
    const t = useDocToken('doc-123')
    await t.fetchToken()
    expect(t.initialTitle.value).toBe('Project kickoff notes')
  })
})

describe('useDocToken — canDelete', () => {
  it('reflects the server-computed delete permission', async () => {
    response.current = { token: 'jwt', readOnly: false, accessMode: 'open-edit', ownerId: null, canDelete: true }
    const t = useDocToken('doc-123')
    await t.fetchToken()
    expect(t.canDelete.value).toBe(true)
  })

  it('defaults to false when the server omits it', async () => {
    const t = useDocToken('doc-123')
    await t.fetchToken()
    expect(t.canDelete.value).toBe(false)
  })
})
