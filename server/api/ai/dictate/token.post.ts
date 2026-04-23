import jwt from 'jsonwebtoken'

// Mints a short-lived JWT for the live-dictation WebSocket. We go this
// route (instead of reading the sealed session cookie inside the WS
// `upgrade` hook) because crossws's upgrade hook gets a raw Request,
// not an H3Event — which is what `nuxt-auth-utils` needs to decrypt
// the cookie. Issuing a JWT here keeps the WS handler simple (verify
// a string) and mirrors exactly how we authenticate Hocuspocus sync.
//
// Token lifetime is kept tight (60s) because it's redeemable ONCE at
// WS upgrade; no need to stretch it for session reuse.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id
  const config = useRuntimeConfig()
  // Prefer the dictation-specific secret; fall back to the Hocuspocus
  // jwtSecret so this still works in dev without setting a second var.
  // Prod should set both independently.
  const secret = config.google.dictateJwtSecret || config.jwtSecret
  if (!secret) {
    throw createError({ statusCode: 500, message: 'JWT secret not configured' })
  }

  const body = await readBody(event) as { docId?: string }
  const docId = body.docId
  if (!docId || typeof docId !== 'string') {
    throw createError({ statusCode: 400, message: 'Missing docId' })
  }

  // Doc-edit access is re-checked on the WS side too (defense in depth),
  // but rejecting here gives the user an immediate 403 before they
  // open a socket that would only fail on the auth message.
  await requireDocEditAccess(docId, userId)

  const token = jwt.sign(
    { userId, docId, kind: 'dictate' },
    secret,
    { expiresIn: '60s' }
  )
  return { token }
})
