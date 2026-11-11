import * as Sentry from '@sentry/nuxt'
import { useStripeClient } from '../../utils/billing/stripeClient'
import { dispatchStripeEvent } from '../../utils/billing/stripeWebhook'

// Stripe webhook entry point: verifies `Stripe-Signature` against the raw body,
// then dispatches to the handlers in `server/utils/billing/stripeWebhook.ts`.
//
// The signature covers the RAW body; re-stringifying parsed JSON changes
// whitespace/key order and breaks verification, so the route declares
// `body: 'raw'` and reads `rawBody()`, never a parsed body.
//
// Responses: 400 on a missing/invalid signature (unrecoverable, Stripe won't
// retry); 500 on handler failure (Stripe retries, which we want); 200 on
// success or an unhandled event type (stops the retry loop).

export default defineApiHandler({
  access: allow.public('Stripe calls this; authenticated by the Stripe-Signature header (HMAC over the raw body) instead of a session'),
  // Billing off: 404 `billing/disabled`, deliberately not 503, which would make
  // Stripe retry a permanent config state. A stray registered endpoint gets
  // 404s until Stripe disables it.
  instance: 'billing',
  body: 'raw',
  handler: async ({ event, rawBody }) => {
    const config = useRuntimeConfig()
    const stripe = useStripeClient()
    // Misconfigured deployment (no secret key / webhook secret): 503 so Stripe
    // retries once the config is fixed.
    if (!stripe) throw apiError('billing/not-configured')
    if (!config.stripe.webhookSecret) throw apiError('billing/not-configured')

    const sig = getRequestHeader(event, 'stripe-signature')
    if (!sig) throw apiError('billing/webhook-signature-missing')

    // Raw bytes, not parsed JSON (see top).
    const raw = await rawBody()
    if (!raw) throw apiError('billing/webhook-body-empty')

    let stripeEvent
    try {
      // `constructEventAsync`: under Bun the SDK uses SubtleCrypto and refuses the
      // synchronous variant. Same signature semantics.
      stripeEvent = await stripe.webhooks.constructEventAsync(raw, sig, config.stripe.webhookSecret)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'verification failed'
      console.warn(`[stripe/webhook] signature verification failed: ${msg}`)
      Sentry.captureException(e, {
        level: 'warning',
        tags: { component: 'stripeWebhook', event: 'signature_verify_failed' }
      })
      throw apiError('billing/webhook-signature-invalid')
    }

    try {
      const result = await dispatchStripeEvent(stripeEvent, { stripe })
      console.log(`[stripe/webhook] ${stripeEvent.type} id=${stripeEvent.id} handled=${result.handled}${result.replayed ? ' replayed=true' : ''}${result.stashed ? ' stashed=true' : ''}`)
      return {
        received: true,
        handled: result.handled,
        // Surface replay short-circuit + stash signals so monitoring and tests can
        // see the dedup path engage; omitted when false.
        ...(result.replayed ? { replayed: true } : {}),
        ...(result.stashed ? { stashed: true } : {})
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'handler failed'
      console.error(`[stripe/webhook] ${stripeEvent.type} failed: ${msg}`, e)
      Sentry.captureException(e, {
        tags: { component: 'stripeWebhook', event: 'dispatch_failed', stripeEventType: stripeEvent.type }
      })
      // 500 makes Stripe retry with backoff, better than acknowledging a failed
      // DB update and losing the state change.
      throw apiError('billing/webhook-failed')
    }
  }
})
