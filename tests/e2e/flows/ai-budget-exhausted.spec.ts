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
  await editor.page.createNewDoc()
  await editor.page.waitForNewDocDialog()
  await editor.page.newDocDialog.titleInput.fill('My next post')
  await editor.page.newDocDialog.submitBlank.click()
  await editor.page.waitForReady()

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

  // ─── One click to /pricing ──────────────────────────────────────
  await flow.heading('Click the bar — land on the upgrade page', 3)
  await flow.narrate(
    'Clicking anywhere in the bar — the input, the send button, '
    + 'the mic — routes you straight to the pricing page instead '
    + 'of attempting a doomed request. No error toast, no silent '
    + 'no-op, just the obvious next step.'
  )

  await flow.click(
    'Click the prompt bar',
    promptInput,
    {
      hero: true,
      result: 'You land on /pricing with the four tier columns side-by-side, ready to upgrade.',
      after: () => page.waitForURL(/\/pricing/, { timeout: 5_000 })
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
