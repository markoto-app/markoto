import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'

// Explicit import — the composable auto-imports `useUserSession` and `ref`,
// both of which the nuxt environment resolves at transform time.
import { useDocToken } from '~/composables/useDocToken'

// Composable under test: owns the auth/access-mode side of a document.
// See app/composables/useDocToken.ts for the contract we're pinning here.
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
  })

  it('falls through when the docId does not match a registered endpoint (404)', async () => {
    // Cross-check that the URL template is `/api/docs/:docId/token`:
    // if we pass a docId we haven't stubbed, Nitro 404s and the catch
    // branch runs.
    const t = useDocToken('unregistered-id')
    await t.fetchToken()

    expect(t.tokenData.value).toEqual({ token: '', readOnly: false })
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
