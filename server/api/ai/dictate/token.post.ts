import jwt from 'jsonwebtoken'
import { resolveBillingContext } from '../../../utils/billing'

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

  // Budget pre-check — mirror the WS-side gate at session open. Without
  // this, an exhausted user gets a token (200), opens the WS, sees the
  // mic-permission browser dialog, clicks Allow, and ONLY then sees the
  // WS close with budget-exhausted. The 402 here saves that whole
  // mic-flash by failing at the click of the mic button. The WS-level
  // gate stays as the safety net (token may go stale by the time the
  // WS opens, or workspace/user state may change in the 60s window).
  //
  // Mirrors the resolveBillingContext call in dictate.ts (workspaceId
  // = null because the dictate JWT doesn't carry workspace context).
  const billing = await resolveBillingContext(userId, null)
  if (billing.interactionsRemaining <= 0) {
    throw createError({
      statusCode: 402,
      message: `You've used all AI actions for this billing period. Upgrade your plan at /pricing to continue.`,
      data: {
        code: 'ai/budget-exhausted',
        messageKey: 'ai.budgetExhaustedDescription',
        recovery: { kind: 'link', href: '/pricing', labelKey: 'ai.upgradeCta' },
        plan: billing.plan,
        remaining: 0
      }
    })
  }

  // `scope: 'dictate'` is critical defense-in-depth. The Hocuspocus
  // auth path in sync-server/src/auth.ts rejects ANY token that
  // carries a non-empty `scope` claim, which means a leaked dictate
  // token can never be replayed against the WS to join the live doc
  // collab session. The WS handler in routes/api/ai/dictate.ts
  // additionally verifies `scope === 'dictate'` to reject tokens
  // minted for any future scope (`render`, `file-access`, …).
  const token = jwt.sign(
    { userId, docId, kind: 'dictate', scope: 'dictate' },
    secret,
    { expiresIn: '60s' }
  )
  return { token }
})
