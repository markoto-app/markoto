// Test-only login shim. Bypasses the OAuth flow for integration tests.
//
// ONLY active when the server is booted with `TEST_MODE=1` on an instance
// that doesn't look like a real deployment (`isTestModeEnabled`, see
// shared/utils/security/testMode.ts). In every other environment this endpoint
// returns 404 — the guard runs before any body parsing — and a real
// deployment with a stray `TEST_MODE=1` refuses to boot at all
// (plugins/01-validate-secrets.ts).
//
// Takes a userId + name, writes a sealed session cookie via the same
// nuxt-auth-utils helper the OAuth handlers use, and returns the session
// data. The test client picks the Set-Cookie header off the response and
// replays it on subsequent calls.
import { isTestModeEnabled } from '../../../shared/utils/security/testMode'
import { getSessionEpoch } from '../../repos/users'

export default defineEventHandler(async (event) => {
  if (!isTestModeEnabled()) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const body = await readBody<{ userId?: unknown, name?: unknown, loggedInAt?: unknown }>(event)
  const userId = Number(body?.userId)
  const name = typeof body?.name === 'string' ? body.name : `User ${userId}`
  if (!Number.isInteger(userId) || userId <= 0) {
    throw createError({ statusCode: 400, message: 'Invalid userId' })
  }

  // Optional `loggedInAt` override (epoch ms) so tests can seal an OLD
  // sign-in and exercise the recent-login guard on sensitive actions.
  const loggedInAt = typeof body?.loggedInAt === 'number' ? body.loggedInAt : Date.now()

  // `v` + `e` + `loggedInAt` mirror what the OAuth handlers write so the
  // validatedSession check doesn't immediately clear the cookie.
  await setUserSession(event, {
    user: { id: userId, name, provider: 'github' },
    loggedInAt,
    e: await getSessionEpoch(userId),
    v: SESSION_VERSION
  })
  return { ok: true, user: { id: userId, name } }
})
