import { eq } from 'drizzle-orm'
import { recordPaidTermsAcceptance, requirePaidTermsAccepted } from '../../utils/billing/paidTerms'
import { users } from '../../db/schema'
import { useDatabase } from '../../utils/platform/database'
import { useStripeClient } from '../../utils/billing/stripeClient'
import { assertBillingEnabled, effectivePlan } from '../../utils/billing/billingMode'
import { requestBaseUrl } from '../../utils/billing/workspaceStripe'
import { automaticTaxEnabled, createTopupCheckout } from '../../utils/billing/topupCheckout'
import { isCurrency, isTopupPackId } from '~~/shared/config/pricing'

// POST /api/billing/topup: buy AI credits for yourself. Body
// {pack: '10'|'25'|'50', currency?}. Pro only: free accounts draw on the shared
// free pool, which credits can't lift (409 `billing/topup-needs-plan`). A
// customer who paid in one currency keeps it (409 `billing/currency-locked`).
// Returns Stripe Checkout `{url, sessionId}`; the webhook records the credit.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  assertBillingEnabled()
  const userId = session.user.id
  if (!(await checkRateLimit('billing-checkout', String(userId), 10, 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many checkout attempts. Try again in a minute.', data: { code: 'billing/rate-limited', messageKey: 'error.rateLimited' } })
  }
  const body = await readBody<{ pack?: unknown, currency?: unknown }>(event)
  if (!isTopupPackId(body?.pack)) throw createError({ statusCode: 400, message: 'Invalid pack.' })
  if (body?.currency !== undefined && !isCurrency(body.currency)) throw createError({ statusCode: 400, message: 'Invalid currency. Must be eur or chf.' })

  const row = (await useDatabase().select({
    email: users.email,
    plan: users.plan,
    planValidUntil: users.planValidUntil,
    stripeCustomerId: users.stripeCustomerId,
    billingCurrency: users.billingCurrency
  }).from(users).where(eq(users.id, userId)).limit(1))[0]
  if (!row) throw createError({ statusCode: 404, message: 'User not found' })
  if (effectivePlan(row.plan, row.planValidUntil) === 'free') {
    throw createError({
      statusCode: 409,
      message: 'AI credits extend a paid plan. Upgrade to Pro first.',
      data: { code: 'billing/topup-needs-plan', messageKey: 'credits.needsPlan' }
    })
  }
  const currency = isCurrency(body?.currency) ? body.currency : (row.billingCurrency ?? 'eur')
  if (row.billingCurrency && row.stripeCustomerId && currency !== row.billingCurrency) {
    throw createError({
      statusCode: 409,
      message: `Your account is billed in ${row.billingCurrency.toUpperCase()}.`,
      data: { code: 'billing/currency-locked', currency: row.billingCurrency, messageKey: 'pricing.currencyLocked' }
    })
  }
  requirePaidTermsAccepted(body)
  const stripe = useStripeClient()
  if (!stripe) throw createError({ statusCode: 503, message: 'Billing is not configured. Contact support.' })
  const base = requestBaseUrl(event)
  const checkout = await createTopupCheckout(stripe, {
    subject: { type: 'user', id: String(userId) },
    pack: body.pack,
    currency,
    customer: row.stripeCustomerId,
    email: row.email,
    clientReferenceId: String(userId),
    successUrl: `${base}/settings/profile?credits=success`,
    cancelUrl: `${base}/settings/profile?credits=cancelled`,
    automaticTax: automaticTaxEnabled(useRuntimeConfig(event).stripe.automaticTax)
  })
  await recordPaidTermsAcceptance(event, userId, { kind: 'topup', subject: { type: 'user', id: String(userId) }, item: body.pack })
  return checkout
})
