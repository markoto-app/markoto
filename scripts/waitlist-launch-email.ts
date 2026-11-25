#!/usr/bin/env bun
/**
 * Send the paid-plans launch email to the waitlist, once, after billing is
 * switched on. `bun run waitlist:launch-email -- --code <CODE> --expires <YYYY-MM-DD> [--dry-run]`.
 *
 * The app image ships this script bundled (Dockerfile: `bun build` ->
 * /app/cli/waitlist-launch-email.js); run it inside the app container,
 * which has every variable below:
 *   docker compose exec app bun cli/waitlist-launch-email.js --code LAUNCH40 --expires 2026-12-10 --dry-run
 *   docker compose exec app bun cli/waitlist-launch-email.js --code LAUNCH40 --expires 2026-12-10
 * Keep it free of Nitro auto-imports so the bundle runs standalone.
 *
 * Every confirmed sign-up gets the localized email (paid plans are live,
 * link to /pricing, the code's 40% off the first year of Pro yearly until
 * the expiry day) and its row is deleted right after the send succeeded.
 * Unconfirmed sign-ups are deleted without email. Safe to re-run: only rows
 * still on the list are mailed. Refuses to run while billing is off, without
 * NUXT_SITE_URL, or (except --dry-run) without real email delivery.
 *
 *   --code <CODE>          the Stripe promotion code (created in Stripe by hand)
 *   --expires <YYYY-MM-DD> the last day the code is valid, as the email states it
 *   --dry-run              print counts only; send and delete nothing
 *   --interval-ms <n>      pause between sends (default 600, under Resend's rate limit)
 *
 * Environment: POSTGRES_* (+ PGSSL like the app), NUXT_BILLING_ENABLED, NUXT_SITE_URL,
 * RESEND_API_KEY, NUXT_EMAIL_FROM.
 */

import { runWaitlistLaunch } from '../server/utils/privacy/waitlistLaunch'
import { closeDatabase } from '../server/db/client'
import { describeError } from '../server/utils/platform/describeError'

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const code = flag(argv, 'code') ?? ''
  const expiresOn = flag(argv, 'expires') ?? ''
  const rawInterval = flag(argv, 'interval-ms')
  const intervalMs = rawInterval === undefined ? undefined : Number(rawInterval)
  if (intervalMs !== undefined && (!Number.isInteger(intervalMs) || intervalMs < 0)) throw new Error('--interval-ms must be a non-negative integer')
  const dryRun = argv.includes('--dry-run')

  try {
    const summary = await runWaitlistLaunch({ code, expiresOn, dryRun, intervalMs, log: line => console.log(`[waitlist-launch] ${line}`) })
    if (dryRun) {
      console.log(`[waitlist-launch] dry run: would email ${summary.confirmed} and delete ${summary.unconfirmed} unconfirmed; nothing sent or deleted`)
      return
    }
    console.log(`[waitlist-launch] done: ${summary.sent} sent and deleted, ${summary.failed} failed (kept), ${summary.deletedUnconfirmed} unconfirmed deleted`)
    if (summary.failed > 0 || summary.stopped) {
      console.log('[waitlist-launch] run it again with the same arguments to retry the failed ones')
      process.exitCode = 2
    }
  } finally {
    await closeDatabase()
  }
}

try {
  await main()
} catch (e) {
  for (const line of describeError(e)) console.error('[waitlist-launch] FAILED (safe to re-run):', line)
  process.exit(1)
}
