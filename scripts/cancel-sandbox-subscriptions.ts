#!/usr/bin/env bun
/**
 * End every live subscription (active, trialing, past due) of the STAGING
 * Stripe sandbox: cancelled at once, no proration, no refund. The staging
 * database reset runs it before it wipes the database, so Stripe and
 * staging start from the same empty state.
 *
 * The app image ships this script bundled (Dockerfile: `bun build` ->
 * /app/cli/cancel-sandbox-subscriptions.js); `scripts/reset-staging-db.sh`
 * runs it inside the staging app container, which has the key:
 *   podman exec markoto-app-1 bun cli/cancel-sandbox-subscriptions.js
 * Keep it free of Nitro auto-imports so the bundle runs standalone.
 *
 * Refuses a live key (`sk_live_` / `rk_live_`) and anything that is not a
 * test key. Without a key (billing never configured) it does nothing.
 * Idempotent; prints counts only, never ids, emails or the key.
 * It talks to Stripe only, never to Postgres.
 *
 * Environment: NUXT_STRIPE_SECRET_KEY (+ NUXT_STRIPE_API_BASE in tests).
 */

import Stripe from 'stripe'
import { useEnv } from '../shared/env/load'
import { STRIPE_API_VERSION } from '../shared/contracts/stripe'
import { buildHostOverride } from '../server/utils/billing/stripeClient'
import { cancelSandboxSubscriptions, checkSandboxKey } from '../server/utils/billing/sandboxSubscriptions'
import { describeError } from '../server/utils/platform/describeError'

const TAG = '[cancel-sandbox-subscriptions]'

async function main(): Promise<void> {
  const env = useEnv()
  const key = env.billing.stripeSecretKey
  const check = checkSandboxKey(key)
  if (!check.ok) {
    if (check.reason === 'missing') {
      console.log(`${TAG} no Stripe key configured: nothing to cancel`)
      return
    }
    console.error(`${TAG} REFUSING: the Stripe key is ${check.reason === 'live' ? 'a LIVE key' : 'not a test-mode key'}`)
    process.exit(1)
  }
  const stripe = new Stripe(key as string, {
    apiVersion: STRIPE_API_VERSION as NonNullable<ConstructorParameters<typeof Stripe>[1]>['apiVersion'],
    ...buildHostOverride(env.billing.stripeApiBase || '')
  })
  const s = await cancelSandboxSubscriptions(stripe)
  console.log(`${TAG} ${s.seen} live, ${s.cancelled} cancelled, ${s.alreadyEnded} already ended, ${s.skipped} left alone (test-suite runs)`)
}

try {
  await main()
} catch (e) {
  for (const line of describeError(e)) console.error(`${TAG} FAILED (safe to re-run):`, line)
  process.exit(1)
}
