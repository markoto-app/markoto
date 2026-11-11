import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { createEvent } from 'h3'

// Admin authority is the `users.is_admin` column. The NUXT_ADMIN_USER_EMAILS
// allowlist only applies at sign-in with a VERIFIED email (adminBootstrap);
// a stored address — which an older sign-in may have recorded unverified —
// must never grant admin on its own at check time.

const findUserById = vi.fn()
vi.mock('../../../server/repos/users', () => ({ findUserById }))

vi.stubGlobal('requireValidatedUserSession', async () => ({ user: { id: 7, name: 'Mallory' } }))
vi.stubGlobal('createError', (opts: { statusCode: number, message: string }) =>
  Object.assign(new Error(opts.message), { statusCode: opts.statusCode }))

const { isAdminUser, requireAdminUser } = await import('../../../server/utils/auth/adminAccess')

const ORIGINAL_ENV = process.env.NUXT_ADMIN_USER_EMAILS
const incoming = new IncomingMessage(new Socket())
const event = createEvent(incoming, new ServerResponse(incoming))

beforeEach(() => {
  findUserById.mockReset()
  process.env.NUXT_ADMIN_USER_EMAILS = 'admin@example.com'
})

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.NUXT_ADMIN_USER_EMAILS
  else process.env.NUXT_ADMIN_USER_EMAILS = ORIGINAL_ENV
})

describe('admin check is column-only', () => {
  it('an allowlisted stored email without the column flag is NOT admin', async () => {
    findUserById.mockResolvedValue({ id: 7, name: 'Mallory', email: 'admin@example.com', isAdmin: false })
    expect(await isAdminUser(7)).toBe(false)
    await expect(requireAdminUser(event)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('the column flag grants admin', async () => {
    findUserById.mockResolvedValue({ id: 7, name: 'Ada', email: null, isAdmin: true })
    expect(await isAdminUser(7)).toBe(true)
    await expect(requireAdminUser(event)).resolves.toMatchObject({ userId: 7 })
  })

  it('a missing user is not admin', async () => {
    findUserById.mockResolvedValue(null)
    expect(await isAdminUser(7)).toBe(false)
    await expect(requireAdminUser(event)).rejects.toMatchObject({ statusCode: 403 })
  })
})
