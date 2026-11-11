import { Pool } from 'pg'
import { test, expect } from '../fixtures/flow'
import { postStripeEvent, stayOnApp, subscriptionUpdatedEvent, topupCompletedEvent } from '../fixtures/stripe'

// "Put a workspace on the Team plan".
//
// User-job: a team lead wants everyone in their workspace to have the
// paid features and a shared AI budget, paid once, per seat. Job done
// when the workspace shows Team, the admin sees seats + AI spend, a
// fourth colleague is invited with "This adds a seat", and one member
// has a lower AI limit.
//
// Stripe Checkout itself is a hosted page on another origin: the flow
// clicks the real button, `stayOnApp` keeps the browser on markoto, and
// the webhook Stripe would send is posted directly (`postStripeEvent`),
// so the Team plan really becomes active. Adding a seat goes through
// stripe-mock for real.
//
// `@billing`: needs NUXT_BILLING_ENABLED=true (the flow stack's billing
// pass).

const DB_URL = 'postgres://ypad:testpassword@localhost:5433/ypad_test'

test('Put a workspace on the Team plan', { tag: '@billing' }, async ({ page, flow, editor }, testInfo) => {
  test.setTimeout(180_000)
  await stayOnApp(page, testInfo)

  // Setup: Maya's workspace with two colleagues
  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')
  const wsRes = await page.request.post('/api/workspaces', { data: { name: 'Northwind research' } })
  expect(wsRes.ok(), await wsRes.text()).toBe(true)
  const { workspaceId } = await wsRes.json() as { workspaceId: string }

  const pool = new Pool({ connectionString: DB_URL, max: 1 })
  let benId = 0
  try {
    for (const [name, role] of [['Ben Ortiz', 'editor'], ['Lena Fischer', 'editor']] as const) {
      const githubId = `flow-team-${name.toLowerCase().replace(/[^a-z]+/g, '-')}-${Date.now()}`
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO users (github_id, name, plan) VALUES ($1, $2, 'free') RETURNING id`,
        [githubId, name]
      )
      await pool.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [workspaceId, rows[0]!.id, role])
      if (name === 'Ben Ortiz') benId = rows[0]!.id
    }
  } finally {
    await pool.end()
  }

  await page.goto(`/w/${workspaceId}`)
  await page.getByRole('tab', { name: /documents/i }).waitFor({ state: 'visible', timeout: 10_000 })

  // Choose the plan
  await flow.heading('Choose Team for the whole workspace', 3)
  await flow.narrate(
    'Team is bought for a workspace, not for a person. You pay per '
    + 'seat, and everyone in the workspace gets Team inside it, with '
    + 'one shared AI budget for the month. Only workspace admins see '
    + 'the Billing tab.'
  )
  await flow.click(
    'Open the Billing tab',
    page.getByRole('tab', { name: /^billing$/i }),
    {
      annotations: [{ label: 'Billing', selector: '[role="tab"]:has-text("Billing")', kind: 'arrow' }],
      result: 'The billing tab shows Team and Business, the billing period, the seats and the total.',
      after: () => page.locator('[data-testid="workspace-billing-buy"]').waitFor({ state: 'visible', timeout: 10_000 })
    }
  )

  // Three people are in the workspace, so three seats is the minimum.
  const seats = page.locator('input[data-testid="workspace-billing-seats"], [data-testid="workspace-billing-seats"] input').first()
  await expect(seats).toHaveValue('3')
  await flow.step('Set four seats, one for the colleague you\'re about to invite', async () => {
    await seats.fill('4')
    await seats.blur()
    await expect(page.locator('[data-testid="workspace-billing-total"]')).toContainText('4 seats')
  }, {
    highlights: [{ label: 'Total', selector: '[data-testid="workspace-billing-total"]' }]
  })

  await expect(page.locator('[data-testid="workspace-billing-checkout"]')).toBeDisabled()
  await flow.click(
    'Tick the box to accept the Paid Plans Terms',
    page.getByTestId('workspace-billing-checkout-paid-terms').getByRole('checkbox'),
    { result: 'Buying needs the box: it accepts the terms and asks for the plan to start right away.' }
  )
  const checkoutPosted = page.waitForResponse(r => r.url().includes(`/api/workspaces/${workspaceId}/billing/checkout`) && r.request().method() === 'POST')
  await flow.click(
    'Click "Continue to payment"',
    page.locator('[data-testid="workspace-billing-checkout"]'),
    { result: 'markoto opens Stripe Checkout for the workspace.' }
  )
  const checkout = await checkoutPosted
  expect(checkout.status()).toBe(200)
  expect(JSON.parse(checkout.request().postData() ?? '{}')).toMatchObject({ plan: 'team', seats: 4, interval: 'month', acceptPaidTerms: true })

  // Stripe (off stage)
  await flow.heading('Pay with Stripe', 3)
  await flow.narrate(
    'Stripe\'s checkout page takes the payment (markoto never sees '
    + 'your card) and sends you back. The invoice names the workspace, '
    + 'and you become its billing admin.'
  )
  const db = new Pool({ connectionString: DB_URL, max: 1 })
  let customer: string
  try {
    const { rows } = await db.query<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM workspace_subscriptions WHERE workspace_id = $1', [workspaceId])
    customer = rows[0]!.stripe_customer_id
  } finally {
    await db.end()
  }
  expect(customer).toMatch(/^cus_/)
  expect(await postStripeEvent(page, subscriptionUpdatedEvent({
    customer,
    subscription: `sub_flow_${workspaceId}`,
    priceId: 'price_test_team',
    quantity: 4
  }))).toBe(200)

  await page.goto(`/w/${workspaceId}?billing=success`)
  await page.locator('[data-testid="workspace-billing-subscription"]').waitFor({ state: 'visible', timeout: 15_000 })
  await expect(page.locator('[data-testid="workspace-plan-badge"]')).toHaveText('Team')
  await expect(page.locator('[data-testid="workspace-billing-subscription"]')).toContainText('3 of 4 seats used')
  await editor.page.dismissToasts()
  await flow.shot(
    'Back on markoto: the workspace is on Team. The tab shows the seats '
    + 'in use, the shared AI budget and what each person used this month.',
    {
      hero: true,
      highlights: [
        { label: 'Team', selector: '[data-testid="workspace-plan-badge"]' },
        { label: 'Seats', selector: '[data-testid="workspace-billing-subscription"]' }
      ]
    }
  )

  // Invite beyond the paid seats
  await flow.heading('Invite more people than you have seats for', 3)
  await flow.narrate(
    'The fourth seat is free, so the first invitation goes straight '
    + 'out. When every seat is taken, markoto asks before adding one: '
    + 'the extra seat is charged pro rata on the next invoice.'
  )
  await page.locator('[data-testid="workspace-invite-people"]').click()
  const email = page.locator('[data-testid="workspace-invite-email"]')
  await email.waitFor({ state: 'visible', timeout: 5_000 })
  await expect(page.locator('[data-testid="workspace-seat-counter"]')).toContainText('3 of 4 seats used')
  await email.fill('sara@northwind.example')
  await page.locator('[data-testid="workspace-invite-submit"]').click()
  await expect(page.locator('[data-testid="workspace-pending-invite-sara@northwind.example"]')).toBeVisible({ timeout: 10_000 })

  await email.fill('omar@northwind.example')
  await flow.click(
    'Invite a fifth person',
    page.locator('[data-testid="workspace-invite-submit"]'),
    {
      result: 'All four seats are taken, so markoto asks whether to add one.',
      after: () => page.locator('[data-testid="workspace-add-seat-confirm"]').waitFor({ state: 'visible', timeout: 10_000 })
    }
  )
  await expect(page.locator('[data-testid="workspace-add-seat-confirm"]')).toContainText('€12 per month')
  await flow.click(
    'Click "Add a seat and invite"',
    page.locator('[data-testid="workspace-add-seat-submit"]'),
    {
      result: 'The plan now has five seats and the invitation is on its way.',
      after: () => expect(page.locator('[data-testid="workspace-pending-invite-omar@northwind.example"]')).toBeVisible({ timeout: 10_000 })
    }
  )
  const db2 = new Pool({ connectionString: DB_URL, max: 1 })
  try {
    const { rows } = await db2.query<{ seats: number }>('SELECT seats FROM workspace_subscriptions WHERE workspace_id = $1', [workspaceId])
    expect(rows[0]?.seats).toBe(5)
  } finally {
    await db2.end()
  }
  await page.keyboard.press('Escape')

  // A member limit
  await flow.heading('Give one person a smaller AI allowance', 3)
  await flow.narrate(
    'By default each member may use up to two seats\' worth of the '
    + 'AI budget a month. You can lower or raise it per person, or '
    + 'remove it; the workspace budget always applies.'
  )
  await page.goto(`/w/${workspaceId}?tab=billing`)
  await page.locator('[data-testid="workspace-billing-usage"]').waitFor({ state: 'visible', timeout: 10_000 })
  const mode = page.locator(`[data-testid="workspace-billing-limit-mode-${benId}"]`)
  await mode.click()
  await page.getByRole('option', { name: /custom limit/i }).click()
  const amount = page.locator(`input[data-testid="workspace-billing-limit-amount-${benId}"], [data-testid="workspace-billing-limit-amount-${benId}"] input`).first()
  await amount.fill('3')
  await amount.blur()
  const saved = page.waitForResponse(r => r.url().includes(`/billing/members/${benId}`) && r.request().method() === 'PATCH')
  await flow.click(
    'Save Ben\'s limit of $3 a month',
    page.locator(`[data-testid="workspace-billing-limit-save-${benId}"]`),
    {
      result: 'Ben can now use up to $3 of the workspace\'s AI budget this month.',
      after: async () => {
        expect((await saved).status()).toBe(200)
        await expect(page.locator(`[data-testid="workspace-billing-member-${benId}"]`)).toContainText('limit $3.00')
      }
    }
  )

  // AI credits
  await flow.heading('Top up the AI budget', 3)
  await flow.narrate(
    'If the workspace needs more AI this month, buy credits. They are '
    + 'used only after the month\'s budget is spent and last a year.'
  )
  await flow.click(
    'Tick the box for the credits',
    page.getByTestId('workspace-billing-paid-terms').getByRole('checkbox'),
    { result: 'For credits the box also says that the right of withdrawal ends once they are used.' }
  )
  const topupPosted = page.waitForResponse(r => r.url().includes(`/api/workspaces/${workspaceId}/billing/topup`) && r.request().method() === 'POST')
  await flow.click(
    'Buy €25 of AI credits',
    page.locator('[data-testid="workspace-billing-buy-25"]'),
    { result: 'Stripe takes the payment for the credits.' }
  )
  expect((await topupPosted).status()).toBe(200)
  expect(await postStripeEvent(page, topupCompletedEvent({ subjectType: 'workspace', subjectId: workspaceId, pack: '25', customer }))).toBe(200)
  await page.goto(`/w/${workspaceId}?tab=billing&credits=success`)
  const creditsCard = page.locator('[data-testid="workspace-billing-credits"]')
  await expect(creditsCard).toContainText('$25.00 in AI credits left', { timeout: 15_000 })
  await editor.page.dismissToasts()
  await creditsCard.scrollIntoViewIfNeeded()
  await flow.shot('The credits are on the workspace, with the date they expire.', {
    highlights: [{ label: 'Credits', selector: '[data-testid="workspace-billing-credits"]' }]
  })

  flow.next({
    slug: 'invite-a-teammate-to-your-workspace',
    why: 'See what your invited colleagues see when they accept'
  })
})
