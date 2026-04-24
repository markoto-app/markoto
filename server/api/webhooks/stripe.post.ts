import { readRawBody } from 'h3'
import { useStripeClient } from '../../utils/stripeClient'
import { dispatchStripeEvent } from '../../utils/stripeWebhook'

// Stripe webhook entry point. Verifies the `Stripe-Signature` header
// against the raw body using our webhook secret, then dispatches to
// per-event handlers in `server/utils/stripeWebhook.ts`.
//
// CRITICAL: Stripe's signature is computed over the RAW body. Any
// JSON parse-and-restringify would change whitespace/key order and
// break verification. h3's `readRawBody` returns the unmodified
// bytes — do NOT switch to `readBody` here.
//
// Response contract:
//   - 400 on missing/invalid signature (Stripe won't retry; signals
//     "your secret is wrong", which is unrecoverable)
//   - 500 on handler failure (Stripe WILL retry — good, we want to
//     see it again after the underlying issue is fixed)
//   - 200 on success OR unknown event type (acknowledge to stop the
//     retry loop on events we genuinely don't handle)

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const stripe = useStripeClient()
  if (!stripe) {
    // Misconfigured deployment — no secret key. Respond 503 so Stripe
    // retries once we fix the config; don't silently 200.
    throw createError({ statusCode: 503, message: 'Stripe not configured' })
  }
  if (!config.stripe.webhookSecret) {
    throw createError({ statusCode: 503, message: 'Stripe webhook secret not configured' })
  }

  const sig = getRequestHeader(event, 'stripe-signature')
  if (!sig) {
    throw createError({ statusCode: 400, message: 'Missing Stripe-Signature header' })
  }

  // Raw bytes — NOT a parsed JSON object. See comment at top.
  const raw = await readRawBody(event, false) // false = Buffer, not string
  if (!raw) {
    throw createError({ statusCode: 400, message: 'Empty request body' })
  }

  let stripeEvent
  try {
    stripeEvent = stripe.webhooks.constructEvent(raw, sig, config.stripe.webhookSecret)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'verification failed'
    console.warn(`[stripe/webhook] signature verification failed: ${msg}`)
    throw createError({ statusCode: 400, message: `Signature verification failed: ${msg}` })
  }

  try {
    const result = await dispatchStripeEvent(stripeEvent, {
      stripe,
      config: {
        pricePro: config.stripe.pricePro,
        priceMax: config.stripe.priceMax,
        priceUltra: config.stripe.priceUltra
      }
    })
    console.log(`[stripe/webhook] ${stripeEvent.type} id=${stripeEvent.id} handled=${result.handled}`)
    return { received: true, handled: result.handled }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'handler failed'
    console.error(`[stripe/webhook] ${stripeEvent.type} failed: ${msg}`, e)
    // 500 → Stripe retries with exponential backoff. Better than
    // acknowledging a failed DB update and losing the state change.
    throw createError({ statusCode: 500, message: `Webhook handler failed: ${msg}` })
  }
})
