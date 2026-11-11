// Test-only login shim that bypasses OAuth for integration tests.
//
// Active only with `TEST_MODE=1` on an instance that doesn't look like a real
// deployment (`isTestModeEnabled`, shared/utils/security/testMode.ts); otherwise
// 404, with the guard before any body parsing. A real deployment with a stray
// `TEST_MODE=1` refuses to boot (plugins/01-validate-secrets.ts).
//
// Writes a sealed session cookie via the same nuxt-auth-utils helper the OAuth
// handlers use; the test client replays the Set-Cookie header.
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
  // validatedSession check doesn't clear the cookie.
  await setUserSession(event, {
    user: { id: userId, name, provider: 'github' },
    loggedInAt,
    e: await getSessionEpoch(userId),
    v: SESSION_VERSION
  })
  return { ok: true, user: { id: userId, name } }
})
