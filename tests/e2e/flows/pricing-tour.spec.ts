import { test, expect } from '../fixtures/flow'

// Two flows on the pricing page.
//
// 1. "What you get on each plan" (untagged → billing-OFF pass, paid
//    plans "coming soon"): three cards (Free, Pro, Teams with a Team /
//    Business switch). Every account is on Free; Pro and Teams show
//    PLANNED prices with no purchase button, and one waitlist bar sits
//    above the cards. Kept for regression coverage of that shape; no docs
//    page embeds it, so scripts/build-flows.ts never publishes it.
// 2. "Pricing with paid plans live" (`@billing`): the same page on an
//    instance that sells plans, the markoto.app shape the docs describe.
//    This is the flow content/docs/plans/limits.md embeds.
//
// Works on desktop AND mobile: the cards stack below `lg`, every card
// keeps its testid.

test('What you get on each plan', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/pricing')
  await page.getByTestId('pricing-tier-free').waitFor({ state: 'visible', timeout: 10_000 })

  await flow.heading('Three plans', 3)
  await flow.narrate(
    'Free, Pro and Teams side by side. Every account is on Free today. '
    + 'Pro and Teams show their planned prices; nothing can be bought yet.'
  )

  // ASSERTION: three cards, Free is the current plan, the paid cards are
  // marked "coming soon" with planned prices and no checkout.
  const pro = page.getByTestId('pricing-tier-pro')
  const teams = page.getByTestId('pricing-option-teams')
  await expect(pro).toBeVisible()
  await expect(teams).toBeVisible()
  await expect(page.getByTestId('pricing-tier-free')).toHaveAttribute('data-current', 'true')
  await expect(pro.getByTestId('pricing-coming-soon-badge')).toBeVisible()
  await expect(pro).toContainText('Planned price')
  await expect(page.getByRole('button', { name: /^upgrade$/i })).toHaveCount(0)

  await flow.shot(
    'You are on the free plan. Pro and Teams are marked "coming soon": planned prices, no checkout.',
    {
      hero: true,
      annotations: [
        { label: 'your plan', selector: '[data-testid="pricing-tier-free"]', kind: 'box' },
        { label: 'coming soon', selector: '[data-testid="pricing-tier-pro"]', kind: 'box' }
      ]
    }
  )

  // Team / Business switch
  await flow.click('Switch the Teams card to "Business"', teams.getByRole('tab', { name: 'Business' }), {
    result: 'Business shows its planned price per seat and what it adds, such as single sign-on.',
    after: () => expect(page.getByTestId('pricing-tier-business')).toBeVisible()
  })
  // ASSERTION: both workspace plans are previews: planned price, the
  // waitlist button instead of a purchase button.
  for (const [plan, label] of [['team', 'Team'], ['business', 'Business']] as const) {
    await teams.getByRole('tab', { name: label }).click()
    const card = page.getByTestId(`pricing-tier-${plan}`)
    await expect(card).toHaveAttribute('data-coming-soon', 'true')
    await expect(card.getByTestId('pricing-join-waitlist')).toBeVisible()
  }

  // Comparison table, folded away
  const toggle = page.getByTestId('pricing-compare-toggle')
  await toggle.scrollIntoViewIfNeeded()
  await flow.click('Click "Compare all details"', toggle, {
    result: 'A table compares every limit and feature of the four plans.',
    after: () => expect(page.getByTestId('pricing-compare-row-aiPoints')).toBeVisible()
  })
  await flow.shot('The table lists every limit side by side.', {
    highlights: [{ label: 'AI Points per month', selector: '[data-testid="pricing-compare-row-aiPoints"]' }]
  })

  // Waitlist
  await flow.heading('Hear when paid plans launch', 3)
  await flow.click('Click "Join the waitlist" on the Pro card', pro.getByTestId('pricing-join-waitlist'), {
    result: 'The page scrolls to the waitlist bar above the cards, ready for your email address.',
    after: () => expect(page.getByTestId('waitlist-section').getByRole('textbox')).toBeFocused()
  })
  await flow.narrate(
    'Want to know when Pro, Team and Business launch? Leave your email on the '
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

// `@billing`: needs NUXT_BILLING_ENABLED=true on the target server (see
// playwright.config.ts `grepInvert`).
test('Pricing with paid plans live', { tag: '@billing' }, async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Login so the page can mark the user's current plan.
  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/pricing')
  await page.locator('[data-testid="pricing-tier-free"]').waitFor({ state: 'visible', timeout: 10_000 })

  await flow.heading('What you get on each plan', 3)
  await flow.narrate(
    'Free, Pro and Teams, where Teams switches between Team and Business. '
    + 'Plans differ in AI Points per month, workspaces you can own and storage. '
    + 'The numbers on this page are the limits markoto applies.'
  )

  const teams = page.getByTestId('pricing-option-teams')
  await expect(page.getByTestId('pricing-tier-team')).toBeVisible()

  await flow.shot(
    'Your current plan (Free) is marked; Team covers a whole workspace, '
    + 'billed per seat.',
    {
      hero: true,
      annotations: [
        { label: 'you are here · Free', selector: '[data-testid="pricing-tier-free"]', kind: 'box' },
        { label: 'a workspace plan, per seat', selector: '[data-testid="pricing-tier-team"]', kind: 'box' }
      ]
    }
  )

  // ASSERTION: every paid plan shows a real price and its CTA; the
  // user's current plan (free for a fresh test user) is marked.
  const pro = page.getByTestId('pricing-tier-pro')
  await expect(pro).toHaveAttribute('data-coming-soon', 'false')
  await expect(pro.getByTestId('pricing-price')).toContainText('€')
  // Pro is bought personally; Team / Business are set up for a workspace.
  await expect(pro.getByRole('button', { name: /upgrade/i })).toBeVisible()
  for (const [plan, label] of [['team', 'Team'], ['business', 'Business']] as const) {
    await teams.getByRole('tab', { name: label }).click()
    const card = page.getByTestId(`pricing-tier-${plan}`)
    await expect(card).toHaveAttribute('data-coming-soon', 'false')
    await expect(card.getByTestId('pricing-price')).toContainText('€')
    await expect(card.getByTestId(`pricing-workspace-plan-${plan}`)).toBeVisible()
  }
  await expect(page.locator('[data-testid="pricing-tier-free"]')).toHaveAttribute('data-current', 'true')
  await expect(page.locator('[data-testid="pricing-tier-free"] [data-testid="pricing-current-plan-badge"]')).toBeVisible()

  flow.next({
    slug: 'use-your-own-ai-provider',
    why: 'Connect your own AI provider: it is never limited by a plan'
  })
})
