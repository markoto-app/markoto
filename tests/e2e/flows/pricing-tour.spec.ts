import { test, expect } from '../fixtures/flow'

test('What you get on each plan', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/pricing')
  await page.getByTestId('pricing-tier-free').waitFor({ state: 'visible', timeout: 10_000 })

  await flow.heading('What every account gets today', 3)
  await flow.narrate(
    'markoto is free while paid plans are being finished. Every account '
    + 'is on Free, with every writing feature. Pro, Max and Ultra show '
    + 'the larger limits they will bring; they have no price yet and '
    + 'nothing to buy.'
  )

  // ASSERTION: Free is the current plan, every paid tier is a preview —
  // a "coming soon" badge, no price, no purchase button.
  await expect(page.getByTestId('pricing-tier-free')).toHaveAttribute('data-current', 'true')
  for (const plan of ['pro', 'max', 'ultra']) {
    const card = page.getByTestId(`pricing-tier-${plan}`)
    await expect(card).toHaveAttribute('data-coming-soon', 'true')
    await expect(card.getByTestId('pricing-coming-soon-badge')).toBeVisible()
    await expect(card.getByTestId('pricing-coming-soon-button')).toBeDisabled()
    await expect(card).not.toContainText('$')
  }
  await expect(page.getByRole('button', { name: /^upgrade$/i })).toHaveCount(0)

  await flow.shot(
    'You are on Free. The paid tiers are marked "coming soon": no prices, no checkout.',
    {
      hero: true,
      annotations: [
        { label: 'your plan', selector: '[data-testid="pricing-tier-free"]', kind: 'box' },
        { label: 'coming soon', selector: '[data-testid="pricing-tier-pro"]', kind: 'box' }
      ]
    }
  )

  // ─── Waitlist ────────────────────────────────────────────────
  await flow.heading('Hear when paid plans launch', 3)
  const section = page.getByTestId('waitlist-section')
  await section.scrollIntoViewIfNeeded()
  await flow.narrate(
    'Want to know when Pro, Max and Ultra launch? Leave your email on the '
    + 'waitlist. markoto sends one email when they do, and every email has '
    + 'an unsubscribe link.'
  )

  await flow.type(
    'Type your email address',
    page.getByTestId('waitlist-email').locator('input').or(page.locator('input[data-testid="waitlist-email"]')).first(),
    'maya@northwind.example',
    { result: 'Your address is filled in.' }
  )

  const submit = page.getByTestId('waitlist-submit')
  // ASSERTION: nothing is sent without consent.
  await expect(submit).toBeDisabled()
  await flow.click(
    'Tick the consent box',
    page.getByTestId('waitlist-consent'),
    {
      result: 'With consent given, the button becomes active.',
      after: () => expect(submit).toBeEnabled()
    }
  )

  await flow.click('Click "Join the waitlist"', submit, {
    result: 'Check your inbox: the sign-up only counts once you click the confirmation link in the email.',
    after: () => expect(page.getByTestId('waitlist-success')).toBeVisible({ timeout: 10_000 })
  })

  flow.next({
    slug: 'use-your-own-ai-provider',
    why: 'Use the AI today on your own provider: no plan needed'
  })
})

// Two flows on the pricing page.
//
// 1. "What you get on each plan" (untagged → billing-OFF pass, the
//    markoto.app shape the docs describe): every account is on Free,
//    paid tiers are "coming soon" with no price and no purchase button,
//    and the waitlist sign-up sits under the grid. This is the flow
//    content/docs/account/plans.md embeds.
// 2. "Pricing with paid plans live" (`@billing`): the same page on an
//    instance that sells plans. Kept for regression coverage only — no
//    docs page embeds it, so scripts/build-flows.ts never publishes it.
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
// `@billing`: needs NUXT_BILLING_ENABLED=true on the target server (see
// playwright.config.ts `grepInvert`).
test('Pricing with paid plans live', { tag: '@billing' }, async ({ page, flow, editor }) => {
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
    + 'workspaces you can own. The numbers on this page are the '
    + 'limits markoto actually applies.'
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
    'All four tiers side-by-side. Your current tier (Free) is '
    + 'outlined; Max is the first tier that can sponsor a whole '
    + 'workspace\'s AI use.',
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
    slug: 'use-your-own-ai-provider',
    why: 'Connect your own AI provider: it is never limited by a plan'
  })
})
