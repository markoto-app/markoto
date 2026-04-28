// Test-only login shim. Bypasses the OAuth flow for integration tests.
//
// ONLY active when the server is booted with `TEST_MODE=1`. In every other
// environment this endpoint returns 404 — the guard runs before any body
// parsing, so there's no surface for accidental exposure in prod if the
// env var is ever set by mistake (it shouldn't be).
//
// Takes a userId + name, writes a sealed session cookie via the same
// nuxt-auth-utils helper the OAuth handlers use, and returns the session
// data. The test client picks the Set-Cookie header off the response and
// replays it on subsequent calls.
export default defineEventHandler(async (event) => {
  if (process.env.TEST_MODE !== '1') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const body = await readBody<{ userId?: unknown, name?: unknown }>(event)
  const userId = Number(body?.userId)
  const name = typeof body?.name === 'string' ? body.name : `User ${userId}`
  if (!Number.isInteger(userId) || userId <= 0) {
    throw createError({ statusCode: 400, message: 'Invalid userId' })
  }

  // `v: SESSION_VERSION` mirrors what the OAuth handlers write so the
  // validatedSession check doesn't immediately clear the cookie.
  await setUserSession(event, {
    user: { id: userId, name, provider: 'github' },
    v: SESSION_VERSION
  })
  return { ok: true, user: { id: userId, name } }
})
