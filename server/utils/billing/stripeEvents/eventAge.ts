// The age rule for subscription state.
//
// Stripe neither orders its webhook deliveries nor delivers each once: an
// event the endpoint failed to acknowledge is sent again for up to three
// days, after newer events of the same subscription went through. Every
// `customer.subscription.*` event carries a full snapshot, so applying an
// older one would put an old plan, billing period or end date back.
//
// Each subject's row therefore stores Stripe's time of the newest state it
// holds (`subscription_event_at`), and a write that comes from a
// subscription snapshot only happens when the snapshot is not older (the
// repos add `subscription_event_at IS NULL OR subscription_event_at <= t`).
// Equal times apply: Stripe's `created` has one-second resolution, and two
// real changes within one second must both land.

/** Stripe's time of an event (`created`, whole seconds). */
export function eventTime(event: { created: number }): Date {
  return new Date(event.created * 1000)
}

/**
 * Stripe's clock when it answered `object` (the `Date` header of the API
 * response the SDK attaches as `lastResponse`), in whole seconds like an
 * event's `created`. Used when the app itself reads or changes a
 * subscription: the state it writes is as of this moment. Our own clock
 * is the fallback (a client without response metadata).
 */
export function stripeResponseTime(object: unknown, now: Date = new Date()): Date {
  const header = responseDateHeader(object)
  const parsed = header ? Date.parse(header) : Number.NaN
  const ms = Number.isFinite(parsed) ? parsed : now.getTime()
  return new Date(Math.floor(ms / 1000) * 1000)
}

function responseDateHeader(object: unknown): string | null {
  if (typeof object !== 'object' || object === null || !('lastResponse' in object)) return null
  const response = object.lastResponse
  if (typeof response !== 'object' || response === null || !('headers' in response)) return null
  const headers = response.headers
  if (typeof headers !== 'object' || headers === null || !('date' in headers)) return null
  return typeof headers.date === 'string' ? headers.date : null
}
