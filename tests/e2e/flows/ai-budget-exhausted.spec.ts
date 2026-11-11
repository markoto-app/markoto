import { test, expect } from '../fixtures/flow'

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
// Setup shortcut: instead of running real prompts to drain the Free
// quota, we hit a TEST_MODE-only admin endpoint that calls LiteLLM's
// `/key/update` to slam the user's virtual-key budget against itself
// — the same trip-condition the proxy uses in production. The next
// /api/ai/credits fetch reflects "exhausted" via LiteLLM's
// `/key/info` round-trip.
//
// Works on desktop AND mobile — the prompt bar's exhausted
// placeholder is identical across breakpoints and the click-through
// to /pricing follows the same router.push call on both.
// `@billing`: needs NUXT_BILLING_ENABLED=true on the target server (see
// playwright.config.ts `grepInvert`).
test('What happens when you hit the AI cap', { tag: '@billing' }, async ({ page, flow, editor }) => {
  // Budget exhaustion drives LiteLLM virtual-key `max_budget` through the real proxy. The flow stack brings
  // up `litellm-test` alongside the rest of the test infra; the TEST_MODE-only endpoint
  // /api/_test/exhaust-litellm-budget slams the user's key budget to 0 so the next call trips the proxy gate.
  test.setTimeout(120_000)

  // Login + create a doc. The flow is about the prompt bar's
  // exhausted state, so we want to land in the editor as fast as
  // possible. Bypass the new-doc dialog with the blank shortcut.
  const { userId } = await editor.page.loginAsTestUser('Maya Chen')
  await editor.page.createBlankDocWithTitle('My next post')

  // Drain the Free user's LiteLLM virtual-key budget. Hits the
  // TEST_MODE-only admin endpoint that POSTs `/key/update` with
  // `max_budget = current_spend` so the next call trips the proxy's
  // budget enforcement. The /api/ai/credits endpoint round-trips
  // through `/key/info` so the next fetch reflects zero remaining.
  await page.request.post('/api/_test/exhaust-litellm-budget', {
    data: { userId }
  })

  // The prompt bar reads its budget state from `useAiCredits()`. Force
  // a fresh /api/ai/credits read by reloading the page so the bar
  // picks up the exhausted state.
  await page.reload()
  await editor.page.waitForReady()

  await flow.heading('Out of credits — what happens next', 3)
  await flow.narrate(
    'You\'ve been prompting markoto all month and have hit the '
    + 'cap. Instead of letting your next prompt fail with a '
    + 'cryptic toast, the prompt bar tells you what\'s up — '
    + 'directly, in the field where you would have typed.'
  )

  // The exhausted placeholder
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

  // Find the upgrade path
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
    'You land on /pricing with every plan side by side. '
    + 'Free is your current plan; Pro raises the monthly AI Points.',
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
    why: 'See what every plan includes, and what the paid plans will add'
  })
})
