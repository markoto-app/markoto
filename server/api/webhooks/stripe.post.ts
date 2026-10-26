import { readRawBody } from 'h3'
import * as Sentry from '@sentry/nuxt'
import { useStripeClient } from '../../utils/stripeClient'
import { dispatchStripeEvent } from '../../utils/stripeWebhook'
import { assertBillingEnabled } from '../../utils/billingMode'

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
  // Billing off → 404 `billing/disabled`. Deliberately not 503: a 503
  // tells Stripe to keep retrying a permanent configuration state. A
  // stray endpoint left registered in the Stripe dashboard gets 404s
  // and Stripe eventually disables it.
  assertBillingEnabled()
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
    // `constructEventAsync` instead of `constructEvent` — under the
    // Bun runtime the SDK detects SubtleCrypto and refuses the
    // synchronous variant ("SubtleCryptoProvider cannot be used in a
    // synchronous context"). The async path uses the same SubtleCrypto
    // primitive correctly. Same signature semantics; just `await`-able.
    stripeEvent = await stripe.webhooks.constructEventAsync(raw, sig, config.stripe.webhookSecret)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'verification failed'
    console.warn(`[stripe/webhook] signature verification failed: ${msg}`)
    Sentry.captureException(e, {
      level: 'warning',
      tags: { component: 'stripeWebhook', event: 'signature_verify_failed' }
    })
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
    console.log(`[stripe/webhook] ${stripeEvent.type} id=${stripeEvent.id} handled=${result.handled}${result.replayed ? ' replayed=true' : ''}${result.stashed ? ' stashed=true' : ''}`)
    return {
      received: true,
      handled: result.handled,
      // Surface replay short-circuit + stash signals so monitoring +
      // tests can verify the dedup path engaged. Omitted when false to
      // keep the happy-path response shape compact.
      ...(result.replayed ? { replayed: true } : {}),
      ...(result.stashed ? { stashed: true } : {})
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'handler failed'
    console.error(`[stripe/webhook] ${stripeEvent.type} failed: ${msg}`, e)
    Sentry.captureException(e, {
      tags: { component: 'stripeWebhook', event: 'dispatch_failed', stripeEventType: stripeEvent.type }
    })
    // 500 → Stripe retries with exponential backoff. Better than
    // acknowledging a failed DB update and losing the state change.
    throw createError({ statusCode: 500, message: `Webhook handler failed: ${msg}` })
  }
})
