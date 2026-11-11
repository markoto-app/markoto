import jwt from 'jsonwebtoken'
import { resolveBillingContext } from '../../../utils/billing/billing'
import { DICTATE_JWT_FIXED_CLAIMS, type DictateJwtPayload } from '../../../../shared/contracts/jwt'

// Mints a short-lived JWT for the live-dictation WebSocket. The WS `upgrade`
// hook gets a raw Request, not the H3Event `nuxt-auth-utils` needs to decrypt
// the session cookie, so the handler verifies this token instead (same as
// Hocuspocus sync). Lifetime is 60s because it is redeemed once at upgrade.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id
  const config = useRuntimeConfig()
  // Dictation-specific secret, falling back to the Hocuspocus jwtSecret so dev
  // works without a second var. Prod should set both independently.
  const secret = config.aiDictateJwtSecret || config.jwtSecret
  if (!secret) {
    throw createError({ statusCode: 500, message: 'JWT secret not configured' })
  }

  const body = await readBody(event)
  const docId = body.docId
  if (!docId || typeof docId !== 'string') {
    throw createError({ statusCode: 400, message: 'Missing docId' })
  }

  // Also re-checked on the WS side; rejecting here gives an immediate 403
  // instead of a socket that fails on the auth message.
  await requireDocEditAccess(docId, userId)

  // No budget pre-check: enforcement is the LiteLLM virtual key's
  // `max_budget`, and an exhausted user's first voice-tick hits the proxy
  // (429, close frame). `resolveBillingContext` lazily provisions the key
  // before the WS opens.
  await resolveBillingContext(userId, null)

  // `scope: 'dictate'`: sync-server/src/auth.ts rejects any token with a
  // non-empty `scope`, so a leaked dictate token can't join a live doc
  // session; routes/api/ai/dictate.ts verifies `scope === 'dictate'` to
  // reject tokens minted for other scopes. `kind` and `scope` come from
  // DICTATE_JWT_FIXED_CLAIMS so mint and verify can't drift.
  const payload = {
    userId,
    docId,
    ...DICTATE_JWT_FIXED_CLAIMS
  } satisfies DictateJwtPayload
  const token = jwt.sign(payload, secret, { expiresIn: '60s' })
  return { token }
})
