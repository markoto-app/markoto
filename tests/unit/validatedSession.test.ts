import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'

// validatedSession.ts is the single gate that proves a sealed cookie
// still matches a real users row. Security-critical path — a bug that
// silently returns a stale session would let a deleted user carry
// their cookie forward, and a bug that ignores SESSION_VERSION would
// deserialise mismatched session shapes into endpoints that assume the
// new contract.
//
// We stub:
//   - `getUserSession` — the raw h3 sealed-cookie reader
//   - `clearUserSession` — must be invoked on stale/deleted cases
//   - `findUserById` — DB lookup for the `id → users.row` validation
//   - `createError` — auto-imported in the SUT
const getUserSession = vi.fn()
const clearUserSession = vi.fn(async () => {})
const findUserById = vi.fn()

vi.stubGlobal('getUserSession', getUserSession)
vi.stubGlobal('clearUserSession', clearUserSession)
vi.stubGlobal('createError', (opts: { statusCode: number, statusMessage?: string, message?: string }) => {
  const err = new Error(opts.message ?? opts.statusMessage ?? '') as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
})

vi.mock('../../server/repos/users', () => ({ findUserById }))

const {
  SESSION_VERSION,
  getValidatedUserSession,
  requireValidatedUserSession
} = await import('../../server/utils/validatedSession')

function fakeEvent(): H3Event {
  // Session cache lives on event.context; start with an empty object so
  // the SUT can attach its cache to it.
  return { context: {} } as unknown as H3Event
}

beforeEach(() => {
  getUserSession.mockReset()
  clearUserSession.mockReset()
  clearUserSession.mockImplementation(async () => {})
  findUserById.mockReset()
})

describe('getValidatedUserSession', () => {
  it('returns null when the cookie has no user.id (anonymous)', async () => {
    getUserSession.mockResolvedValueOnce({})
    const r = await getValidatedUserSession(fakeEvent())
    expect(r).toBeNull()
    // Anonymous is not "stale" — no cookie clear.
    expect(clearUserSession).not.toHaveBeenCalled()
    expect(findUserById).not.toHaveBeenCalled()
  })

  it('returns null when session.user.id is not a number', async () => {
    getUserSession.mockResolvedValueOnce({ user: { id: 'not-a-number' }, v: SESSION_VERSION })
    const r = await getValidatedUserSession(fakeEvent())
    expect(r).toBeNull()
    expect(clearUserSession).not.toHaveBeenCalled()
  })

  it('clears the cookie and returns null when SESSION_VERSION is stale', async () => {
    getUserSession.mockResolvedValueOnce({ user: { id: 42 }, v: SESSION_VERSION - 1 })
    const r = await getValidatedUserSession(fakeEvent())
    expect(r).toBeNull()
    expect(clearUserSession).toHaveBeenCalledOnce()
    // DB lookup never happens — version check is before the findUserById call.
    expect(findUserById).not.toHaveBeenCalled()
  })

  it('clears the cookie and returns null when v is missing entirely', async () => {
    // Sessions sealed before we introduced SESSION_VERSION have no `v`
    // field at all. Same remediation as a stale version — clear + treat
    // as anonymous so the user re-auths into the current shape.
    getUserSession.mockResolvedValueOnce({ user: { id: 42 } })
    const r = await getValidatedUserSession(fakeEvent())
    expect(r).toBeNull()
    expect(clearUserSession).toHaveBeenCalledOnce()
  })

  it('clears the cookie and returns null when the user row is gone', async () => {
    // Sealed cookies survive DB resets. Without this check, a deleted
    // user's cookie would carry forward and silently misattribute writes.
    getUserSession.mockResolvedValueOnce({ user: { id: 42 }, v: SESSION_VERSION })
    findUserById.mockResolvedValueOnce(null)
    const r = await getValidatedUserSession(fakeEvent())
    expect(r).toBeNull()
    expect(clearUserSession).toHaveBeenCalledOnce()
  })

  it('returns {id,name} on a valid session', async () => {
    getUserSession.mockResolvedValueOnce({ user: { id: 42 }, v: SESSION_VERSION })
    findUserById.mockResolvedValueOnce({ id: 42, name: 'Alice', email: 'a@b.c' })
    const r = await getValidatedUserSession(fakeEvent())
    expect(r).toEqual({ user: { id: 42, name: 'Alice' } })
  })

  it('only surfaces id + name from the DB row, not email/avatar/etc', async () => {
    // The public contract is {id, name}. Surfacing more fields here
    // would leak whatever happens to live on UserRow today — brittle
    // and unnecessary. Pin the shape.
    getUserSession.mockResolvedValueOnce({ user: { id: 42 }, v: SESSION_VERSION })
    findUserById.mockResolvedValueOnce({
      id: 42,
      name: 'Alice',
      email: 'a@b.c',
      githubId: 'abc',
      googleId: null,
      avatarUrl: 'http://...'
    })
    const r = await getValidatedUserSession(fakeEvent())
    expect(Object.keys(r!.user).sort()).toEqual(['id', 'name'])
  })

  it('caches the result on event.context — second call hits no deps', async () => {
    // The cache is what lets every endpoint call requireValidatedUserSession
    // on top of middleware's call without re-querying the DB per request.
    const event = fakeEvent()
    getUserSession.mockResolvedValueOnce({ user: { id: 42 }, v: SESSION_VERSION })
    findUserById.mockResolvedValueOnce({ id: 42, name: 'Alice' })

    await getValidatedUserSession(event)
    await getValidatedUserSession(event)

    expect(getUserSession).toHaveBeenCalledTimes(1)
    expect(findUserById).toHaveBeenCalledTimes(1)
  })

  it('caches the anonymous outcome too', async () => {
    // Otherwise every middleware + endpoint call would re-open the
    // sealed cookie for an anonymous request.
    const event = fakeEvent()
    getUserSession.mockResolvedValueOnce({})

    await getValidatedUserSession(event)
    await getValidatedUserSession(event)

    expect(getUserSession).toHaveBeenCalledTimes(1)
  })
})

describe('requireValidatedUserSession', () => {
  it('throws 401 when there is no valid session', async () => {
    getUserSession.mockResolvedValueOnce({})
    await expect(requireValidatedUserSession(fakeEvent())).rejects.toMatchObject({
      statusCode: 401
    })
  })

  it('throws 401 when the user row is missing (cookie survived DB reset)', async () => {
    getUserSession.mockResolvedValueOnce({ user: { id: 42 }, v: SESSION_VERSION })
    findUserById.mockResolvedValueOnce(null)
    await expect(requireValidatedUserSession(fakeEvent())).rejects.toMatchObject({
      statusCode: 401
    })
    // And the cookie is cleared as a side-effect so the next request is anonymous.
    expect(clearUserSession).toHaveBeenCalledOnce()
  })

  it('returns {user:{id,name}} on a valid session', async () => {
    getUserSession.mockResolvedValueOnce({ user: { id: 42 }, v: SESSION_VERSION })
    findUserById.mockResolvedValueOnce({ id: 42, name: 'Alice' })
    const r = await requireValidatedUserSession(fakeEvent())
    expect(r).toEqual({ user: { id: 42, name: 'Alice' } })
  })
})
