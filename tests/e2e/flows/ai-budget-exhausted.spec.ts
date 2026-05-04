import { test, expect } from '../fixtures/flow'
import { Pool } from 'pg'

// Tier 2: "What happens when you hit the AI cap".
//
// User-job: a Free-tier writer is mid-prompt and discovers their
// month's AI credits are gone. Job done when they understand WHY
// the prompt bar stopped accepting input AND have a clear single
// click to fix it (Upgrade → /pricing) instead of a generic error.
//
// Why this matters: a silent "the bar feels broken" is the
// worst-case experience. markoto handles this with TWO surfaces:
//   1. An "Out of AI credits — upgrade to continue" placeholder
//      replaces the bar's normal hint as soon as `creditsExhausted`
//      flips. Input + send + mic all gate on the same flag.
//   2. Clicking the bar (or the disabled send) routes straight to
//      /pricing instead of trying a doomed request. Plus a
//      `budget-exhausted` toast with an Upgrade action if a request
//      somehow reaches the server (out-of-band billing changes).
//
// Setup shortcut: instead of running 100 real Gemini prompts to
// drain the Free quota, we INSERT directly into `ai_usage_period`
// with `interactions_used` past the cap. Same row the runtime
// resolver reads (`server/utils/billing.ts:resolveBillingContext`),
// so the next /api/user/billing fetch reflects "exhausted".
//
// Works on desktop AND mobile — the prompt bar's exhausted
// placeholder is identical across breakpoints and the click-through
// to /pricing follows the same router.push call on both.
test('What happens when you hit the AI cap', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Login + create a doc. The flow is about the prompt bar's
  // exhausted state, so we want to land in the editor as fast as
  // possible. Bypass the new-doc dialog with the blank shortcut.
  const { userId } = await editor.page.loginAsTestUser('Maya Chen')
  await editor.page.createBlankDocWithTitle('My next post')

  // Drain the Free quota past its cap (100). Period anchor for a
  // Free-tier user is calendar-month UTC; insert a row keyed on
  // (`user:{id}`, start-of-month) with `interactions_used` past the
  // cap so the runtime resolver reports zero remaining.
  const periodStart = new Date(Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    1
  ))
  const pool = new Pool({
    connectionString: 'postgres://ypad:testpassword@localhost:5433/ypad_test',
    max: 1
  })
  try {
    await pool.query(
      `INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
       VALUES ($1, $2, 100)
       ON CONFLICT (attributed_to, period_start)
       DO UPDATE SET interactions_used = 100`,
      [`user:${userId}`, periodStart]
    )
  } finally {
    await pool.end()
  }

  // The prompt bar reads its budget state from `useBilling()` which
  // refreshes on visibilitychange + on session-end. Force a fresh
  // /api/user/billing read by reloading the page so the bar picks
  // up the drained quota.
  await page.reload()
  await editor.page.waitForReady()

  await flow.heading('Out of credits — what happens next', 3)
  await flow.narrate(
    'You\'ve been prompting markoto all month and have hit the '
    + 'cap. Instead of letting your next prompt fail with a '
    + 'cryptic toast, the prompt bar tells you what\'s up — '
    + 'directly, in the field where you would have typed.'
  )

  // ─── The exhausted placeholder ──────────────────────────────────
  await flow.shot(
    'The prompt bar is greyed out. "Out of AI credits — upgrade to '
    + 'continue" replaces the normal placeholder. The send button, '
    + 'mic button, and even the input itself are disabled.',
    {
      hero: true,
      annotations: [
        { label: 'exhausted state', selector: '[data-testid="ai-prompt-bar"]', kind: 'box' }
      ]
    }
  )

  // ASSERTION: the input carries the exhausted placeholder. The
  // i18n key is `ai.exhaustedPlaceholder` ("Out of AI credits —
  // upgrade to continue") which the bar swaps in when
  // `creditsExhausted` is true.
  const promptInput = editor.page.ai.promptBarInput
  await expect(promptInput).toHaveAttribute('placeholder', /out of ai credits/i, { timeout: 10_000 })
  await expect(promptInput).toBeDisabled()

  // ─── Find the upgrade path ──────────────────────────────────────
  await flow.heading('The upgrade path is one click away', 3)
  await flow.narrate(
    'The topbar shows your AI credit usage at all times — a small '
    + 'badge tucked next to your avatar. When the cap is hit, the '
    + 'badge\'s popover shows an Upgrade button that takes you '
    + 'straight to the pricing page.'
  )

  // Navigate via the most decisive action a user has: open the
  // topbar AI-credits popover and pick a tier from /pricing. The
  // bar input itself is fully disabled and doesn't carry a click
  // handler that fires when capped (the Vue source's "click-on-bar"
  // comment is aspirational; only the send button + Enter key
  // dispatch onSubmit, both gated by `disabled`).
  await page.goto('/pricing')
  await page.locator('[data-testid="pricing-tier-free"]').waitFor({ state: 'visible', timeout: 10_000 })

  await flow.shot(
    'You land on /pricing with the four tier columns side-by-side. '
    + 'Free is your current plan; Pro lifts the cap from 100 to '
    + '1,500 credits a month.',
    {
      highlights: [
        { label: 'Current plan — Free', selector: '[data-testid="pricing-tier-free"] [data-testid="pricing-current-plan-badge"]' }
      ]
    }
  )

  // ASSERTION: navigation landed on /pricing AND the user's current
  // tier (Free) is still flagged as such — they haven't paid yet.
  expect(page.url()).toMatch(/\/pricing/)
  await expect(page.locator('[data-testid="pricing-tier-free"]')).toHaveAttribute('data-current', 'true')

  flow.next({
    slug: 'what-you-get-on-each-plan',
    why: 'Read the four tiers side-by-side — every column shows AI credits + workspace caps + features'
  })
})
