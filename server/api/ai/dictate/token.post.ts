import jwt from 'jsonwebtoken'
import { resolveBillingContext } from '../../../utils/billing'
import { DICTATE_JWT_FIXED_CLAIMS, type DictateJwtPayload } from '../../../../shared/contracts/jwt'

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
  const secret = config.aiDictateJwtSecret || config.jwtSecret
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

  // Phase 6: budget pre-check removed. Budget enforcement is delegated
  // to the LiteLLM virtual key's `max_budget`; an exhausted user's first
  // voice-tick post hits the proxy and surfaces a 429 → close-frame.
  // The pre-Phase-6 mic-flash UX is no longer guarded here because we
  // have no app-side counter to read; lazy-creating the LiteLLM key
  // happens inside `resolveBillingContext` so the key is provisioned
  // before the WS opens (and dictate routes through it).
  await resolveBillingContext(userId, null)

  // `scope: 'dictate'` is critical defense-in-depth. The Hocuspocus
  // auth path in sync-server/src/auth.ts rejects ANY token that
  // carries a non-empty `scope` claim, which means a leaked dictate
  // token can never be replayed against the WS to join the live doc
  // collab session. The WS handler in routes/api/ai/dictate.ts
  // additionally verifies `scope === 'dictate'` to reject tokens
  // minted for any future scope (`render`, `file-access`, …).
  // `kind` and `scope` come from DICTATE_JWT_FIXED_CLAIMS so the
  // literal values can never drift between mint and verify.
  const payload = {
    userId,
    docId,
    ...DICTATE_JWT_FIXED_CLAIMS
  } satisfies DictateJwtPayload
  const token = jwt.sign(payload, secret, { expiresIn: '60s' })
  return { token }
})
