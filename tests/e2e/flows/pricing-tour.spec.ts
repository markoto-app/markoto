import { test, expect } from '../fixtures/flow'

// Tier 1: "What you get on each plan".
//
// User-job: a reader trying to figure out whether the Free tier is
// enough OR which paid tier they need. Job done when they've landed
// on the pricing page, seen the four columns (Free / Pro / Max /
// Ultra) with their AI credits + workspace caps + features called
// out, and can identify their current plan visually.
//
// What this flow is NOT: a checkout-completion demo. The "Upgrade"
// CTAs lead to Stripe Checkout — driving that end-to-end requires
// the Stripe-mock fixture to redirect back through Nuxt, which is
// its own setup. This flow stops at the pricing page; the buyer's
// next click is the Upgrade button.
//
// Works on desktop AND mobile — pricing grid stacks at narrow widths
// (`lg:grid-cols-4` collapses to a single column below `lg`), every
// tier card is still in the DOM with its testid, and the
// `box`-kind annotations wrap the stacked cards correctly. Verified
// against `en-light-mobile` (375×667). No `test.skip()` for mobile.
test('What you get on each plan', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Login so the page can highlight the user's current tier with
  // the shu border + ring (anonymous viewers don't get the visual
  // anchor; the flow's payoff includes "see what tier you're on").
  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/pricing')
  // The pricing page is a static SSR render; wait for the tier grid
  // to be in the DOM rather than a fixed timeout.
  await page.locator('[data-testid="pricing-tier-free"]').waitFor({ state: 'visible', timeout: 10_000 })

  await flow.heading('What you get on each plan', 3)
  await flow.narrate(
    'markoto has four tiers — Free, Pro, Max, Ultra — split along '
    + 'the two axes that actually matter: AI credits per month and '
    + 'workspaces you can own. The page reads from the same tier '
    + 'config the server uses, so the numbers here are the numbers '
    + 'the server enforces.'
  )

  // ─── The full grid, with three direction-anchoring annotations ──
  // The page is static — there's no state change to capture between
  // "before" and "after". Instead of three duplicate screenshots
  // distinguished only by which tier the highlight wraps, we anchor
  // ALL three callouts on a single hero frame. The reader sees one
  // image with three labelled affordances (you-are-here, sponsorship
  // unlock, the cap that drives the decision), which is what the
  // narration is actually about.
  await flow.shot(
    'All four tiers side-by-side. Your current tier (Free) carries '
    + 'a shu border + ring; Max is the sponsorship-eligible tier '
    + 'where teams unlock the (+) workspace mechanic.',
    {
      hero: true,
      annotations: [
        { label: 'you are here · Free', selector: '[data-testid="pricing-tier-free"]', kind: 'box' },
        { label: 'AI sponsorship unlocks at Max', selector: '[data-testid="pricing-tier-max"]', kind: 'box' }
      ]
    }
  )

  // ASSERTION: all four tier cards rendered + the user's current
  // plan (free for a fresh test user) is marked as such via the
  // `data-current="true"` attribute.
  await expect(page.locator('[data-testid="pricing-tier-free"]')).toBeVisible()
  await expect(page.locator('[data-testid="pricing-tier-pro"]')).toBeVisible()
  await expect(page.locator('[data-testid="pricing-tier-max"]')).toBeVisible()
  await expect(page.locator('[data-testid="pricing-tier-ultra"]')).toBeVisible()
  await expect(page.locator('[data-testid="pricing-tier-free"]')).toHaveAttribute('data-current', 'true')
  // The "current plan" badge anchors the visual claim the narration
  // makes: "your current tier (Free)". Without it, the only signal
  // was the shu border ring — readable, but easy to miss in a hero
  // shot. The badge now sits above the Free card.
  await expect(page.locator('[data-testid="pricing-tier-free"] [data-testid="pricing-current-plan-badge"]')).toBeVisible()

  flow.next({
    slug: 'let-your-team-use-the-ai-on-your-dime',
    why: 'See how AI sponsorship works once you\'re on Max'
  })
})
