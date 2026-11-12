import { test, expect } from '../fixtures/flow'

// Two flows on the pricing page.
//
// 1. "What you get on each plan" (untagged → billing-OFF pass, the
//    markoto.app shape the docs describe): four options side by side
//    (self-hosted, no account, free account, paid with Pro / Team /
//    Business tabs). Every account is on Free; the paid tabs show PLANNED
//    prices and limits with no purchase button, and the waitlist sign-up
//    sits right under the columns. This is the flow
//    content/docs/account/plans.md embeds.
// 2. "Pricing with paid plans live" (`@billing`): the same page on an
//    instance that sells plans. Kept for regression coverage only, no
//    docs page embeds it, so scripts/build-flows.ts never publishes it.
//
// Works on desktop AND mobile, the columns stack below `md`, the paid
// tabs stay a row of three, every card keeps its testid.

const PAID = [
  { plan: 'pro', label: 'Pro' },
  { plan: 'team', label: 'Team' },
  { plan: 'business', label: 'Business' }
] as const

test('What you get on each plan', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/pricing')
  await page.getByTestId('pricing-tier-free').waitFor({ state: 'visible', timeout: 10_000 })

  await flow.heading('Four ways to use markoto', 3)
  await flow.narrate(
    'You can run markoto on your own server, write without an account, '
    + 'or sign in for a free account. Every account is on Free today. '
    + 'Pro, Team and Business show their planned prices and limits; nothing '
    + 'can be bought yet.'
  )

  // ASSERTION: the four options, Free is the current plan, the paid
  // column is marked "coming soon" with planned prices and no checkout.
  for (const id of ['pricing-option-self-hosted', 'pricing-option-anon', 'pricing-option-paid']) {
    await expect(page.getByTestId(id)).toBeVisible()
  }
  await expect(page.getByTestId('pricing-tier-free')).toHaveAttribute('data-current', 'true')
  const paid = page.getByTestId('pricing-option-paid')
  await expect(paid.getByTestId('pricing-coming-soon-badge')).toBeVisible()
  await expect(page.getByTestId('pricing-tier-pro')).toBeVisible()
  await expect(page.getByTestId('pricing-tier-pro')).toContainText('Planned price')
  await expect(page.getByRole('button', { name: /^upgrade$/i })).toHaveCount(0)

  await flow.shot(
    'You are on the free account. The paid plans are marked "coming soon": planned prices, no checkout.',
    {
      hero: true,
      annotations: [
        { label: 'your plan', selector: '[data-testid="pricing-tier-free"]', kind: 'box' },
        { label: 'coming soon', selector: '[data-testid="pricing-option-paid"]', kind: 'box' }
      ]
    }
  )

  // Paid tabs
  await flow.click('Click the "Team" tab', paid.getByRole('tab', { name: 'Team' }), {
    result: 'Team shows its planned price per seat and the limits each seat adds to the workspace.',
    after: () => expect(page.getByTestId('pricing-tier-team')).toBeVisible()
  })
  // ASSERTION: every paid tab is a preview, planned price, the
  // waitlist link instead of a purchase button.
  for (const { plan, label } of PAID) {
    await paid.getByRole('tab', { name: label }).click()
    const panel = page.getByTestId(`pricing-tier-${plan}`)
    await expect(panel).toBeVisible()
    await expect(panel).toHaveAttribute('data-coming-soon', 'true')
    await expect(panel.getByTestId('pricing-join-waitlist')).toBeVisible()
  }

  // Comparison table
  const compare = page.getByTestId('pricing-compare')
  await compare.scrollIntoViewIfNeeded()
  await expect(compare.getByTestId('pricing-compare-row-aiPoints')).toBeVisible()
  await flow.shot('Below the cards, a table compares every limit side by side.', {
    highlights: [{ label: 'AI Points per month', selector: '[data-testid="pricing-compare-row-aiPoints"]' }]
  })

  // Waitlist
  await flow.heading('Hear when paid plans launch', 3)
  const section = page.getByTestId('waitlist-section')
  await section.scrollIntoViewIfNeeded()
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
    'The free account, then Pro, Team and Business under the Paid tabs. Plans '
    + 'differ in AI Points per month, workspaces you can own and storage. '
    + 'The numbers on this page are the limits markoto applies.'
  )

  const paid = page.getByTestId('pricing-option-paid')
  await paid.getByRole('tab', { name: 'Team' }).click()
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

  // ASSERTION: every paid tab shows a real price and an upgrade CTA;
  // the user's current plan (free for a fresh test user) is marked.
  for (const { plan, label } of PAID) {
    await paid.getByRole('tab', { name: label }).click()
    const panel = page.getByTestId(`pricing-tier-${plan}`)
    await expect(panel).toBeVisible()
    await expect(panel).toHaveAttribute('data-coming-soon', 'false')
    await expect(panel.getByTestId('pricing-price')).toContainText('€')
    // Pro is bought personally; Team / Business are set up for a workspace.
    await expect(plan === 'pro' ? panel.getByRole('button', { name: /upgrade/i }) : panel.getByTestId(`pricing-workspace-plan-${plan}`)).toBeVisible()
  }
  await expect(page.locator('[data-testid="pricing-tier-free"]')).toHaveAttribute('data-current', 'true')
  await expect(page.locator('[data-testid="pricing-tier-free"] [data-testid="pricing-current-plan-badge"]')).toBeVisible()

  flow.next({
    slug: 'use-your-own-ai-provider',
    why: 'Connect your own AI provider: it is never limited by a plan'
  })
})
