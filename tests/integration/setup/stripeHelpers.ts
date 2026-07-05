import { createHmac } from 'crypto'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

// Helpers for testing Stripe webhook + endpoint flows.
//
// Fixtures: JSON event objects committed under
// `tests/fixtures/stripe/` — one per event type we handle. Each
// carries a realistic shape from Stripe's docs / CLI, with IDs
// replaced by readable placeholders (`cus_test_alice`, `sub_test_pro`,
// etc.) so tests can set up DB state with matching references.
//
// Signature: Stripe webhooks arrive with a `Stripe-Signature` header
// that encodes `t=<ts>,v1=<hmacsha256(ts.body, whsec)>`. The real SDK
// verifies this in `stripe.webhooks.constructEvent`. We construct
// legitimate signatures with our test webhook secret so the full
// verification path runs in tests — not a bypass. That way a bug in
// signature parsing is caught here, not at prod first-run.

// ESM-safe fixture dir (`__dirname` is undefined under the Node ESM loader
// Playwright uses — it only worked when Bun's compat polyfill was present).
// This file is imported by upgrade-to-pro.spec.ts, so it must load in both.
const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/stripe', import.meta.url))

/**
 * Test webhook secret. Arbitrary string — must match what the
 * integration test env sets as `NUXT_STRIPE_WEBHOOK_SECRET`.
 */
export const TEST_WEBHOOK_SECRET = 'whsec_test_integration'

/**
 * Load a fixture by filename stem (without `.json`). Returns the
 * parsed JSON object. Each call re-reads so tests can mutate the
 * returned object freely without polluting the next test.
 */
export function loadStripeFixture(name: string): Record<string, unknown> {
  const path = resolve(FIXTURE_DIR, `${name}.json`)
  const raw = readFileSync(path, 'utf-8')
  return JSON.parse(raw)
}

/**
 * Compute Stripe's `v1` webhook signature for the given payload. This
 * reproduces `stripe.webhooks.generateTestHeaderString` exactly; we
 * reimplement to keep tests independent of the SDK's internal helper
 * (which moved namespaces between versions).
 */
export function computeStripeSig(payload: string, secret: string, now?: number): string {
  const ts = now ?? Math.floor(Date.now() / 1000)
  const signedPayload = `${ts}.${payload}`
  const v1 = createHmac('sha256', secret).update(signedPayload).digest('hex')
  return `t=${ts},v1=${v1}`
}

/**
 * Build a Stripe-style Event wrapping any arbitrary data object. Useful
 * when we want to hand-construct events without committing a JSON
 * fixture — for example, testing idempotency by replaying the same
 * event twice with different timestamps.
 */
export function makeStripeEvent(
  type: string,
  data: Record<string, unknown>,
  overrides?: Partial<{ id: string, livemode: boolean }>
): Record<string, unknown> {
  return {
    id: overrides?.id ?? `evt_test_${type.replace(/\./g, '_')}_${Math.random().toString(36).slice(2, 8)}`,
    object: 'event',
    api_version: '2024-12-18.acacia',
    created: Math.floor(Date.now() / 1000),
    livemode: overrides?.livemode ?? false,
    type,
    data: { object: data },
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null }
  }
}
