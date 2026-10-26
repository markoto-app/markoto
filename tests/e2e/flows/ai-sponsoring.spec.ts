import { test, expect } from '../fixtures/flow'
import { Pool } from 'pg'

// Tier 2: "Let your team use the AI on your dime".
//
// User-job: a Max-tier user starting a workspace for their team wants
// the team's markoto-AI use to bill against THEIR pool, not against
// each member's free quota. Job done when they've toggled "AI
// sponsoring" on in the workspace's AI tab and seen the workspace's
// state flip to a sponsored configuration.
//
// What the toggle actually does on the server (per `billing.ts`):
// when `workspaces.aiEnabled = true` AND `workspaces.billingOwnerId`
// matches a user on a `max`/`ultra` plan with `planValidUntil > now()`,
// every workspace member's AI calls — every prompt, every comment-
// triggered @ai response, every voice transcription — bills against
// the BILLING OWNER's `ai_usage_period` row, not the member's. If the
// owner ever lapses (cancels, downgrades to Pro, payment fails), the
// per-call resolver detects it and silently routes that call back to
// the member's own quota; the workspace row is also corrected by the
// `plan-lapse-sweep` background job.
//
// Setup shortcut: this flow promotes Maya to Max via direct DB UPDATE
// (same pattern as `tests/integration/endpoints/aiDictateWs.test.ts`).
// We don't drive the actual Stripe Checkout flow here — that's its own
// flow candidate and would need a Stripe-mock fixture. The triple
// `(plan='max', plan_valid_until=<future>, stripe_current_period_start=
// <past>)` is enough to satisfy the runtime resolver.
//
// Runs on desktop AND mobile. The workspace AI tab uses the same
// Reka UTabs surface as Documents / Knowledge / Settings — it reflows
// under `<sm` like every other tab. Mobile shows the explanation
// copy stacked above the toggle (instead of a desktop two-column
// shape), but the asserted server state — `aiEnabled === true`,
// `billingOwnerId` set — is identical.
// `@billing`: needs NUXT_BILLING_ENABLED=true on the target server (see
// playwright.config.ts `grepInvert`).
test('Let your team use the AI on your dime', { tag: '@billing' }, async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Login + promote to Max. The promotion is direct DB UPDATE because
  // driving Stripe Checkout end-to-end would require the Stripe-mock
  // container to redirect-back through Nuxt; that's a separate flow.
  // The triple is what `resolveBillingContext` checks: paid plan,
  // valid-until in the future, period-start in the past.
  const { userId } = await editor.page.loginAsTestUser('Maya Chen')
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // +30d
  const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) // −5d
  const pool = new Pool({
    connectionString: 'postgres://ypad:testpassword@localhost:5433/ypad_test',
    max: 1
  })
  try {
    await pool.query(
      `UPDATE users SET plan='max', plan_valid_until=$1, stripe_current_period_start=$2 WHERE id=$3`,
      [future, past, userId]
    )
  } finally {
    await pool.end()
  }

  // Touch the dashboard once so the freshly-set session cookie hits
  // the user/billing endpoint and the in-app billing state hydrates
  // with the new plan. Without this, the workspace AI tab fetches
  // /api/user/billing on mount and may briefly resolve as Free → the
  // toggle stays disabled with "Requires Max or Ultra".
  await page.goto('/')

  // Create a workspace via API. Story-relevant clicks happen INSIDE
  // the workspace; creating it through the UI again would just
  // re-tell `workspace-tour`'s setup. The flow is about the AI tab,
  // not the create-workspace dance.
  const wsRes = await page.request.post('/api/workspaces', {
    data: { name: 'Ship-team library' }
  })
  if (!wsRes.ok()) {
    throw new Error(`[ai-sponsoring] workspace create failed: ${wsRes.status()} ${await wsRes.text()}`)
  }
  const ws = await wsRes.json() as { workspaceId: string }
  await page.goto(`/w/${ws.workspaceId}`)
  await page.getByRole('tab', { name: /documents/i }).waitFor({ state: 'visible', timeout: 10_000 })

  await flow.heading('Let your team use the AI on your dime', 3)
  await flow.narrate(
    'You\'re on Max — your AI quota is huge. Your teammates are on '
    + 'Free, and they\'re going to hit the cap fast if they do real '
    + 'work in this workspace. Sponsor their use: every markoto '
    + 'request a member makes inside this workspace bills against '
    + 'YOUR pool instead of theirs. Toggle once; durable until you '
    + 'lapse, downgrade, or turn it back off.'
  )

  // ─── Open the AI tab ────────────────────────────────────────────
  await flow.click(
    'Open the AI tab',
    page.getByRole('tab', { name: /^markoto$/i }).or(page.getByRole('tab').filter({ hasText: /^markoto$/i })).first(),
    {
      annotations: [
        { label: 'AI tab', selector: '[role="tab"]:has-text("markoto"):not([aria-selected="true"])', kind: 'arrow' }
      ],
      result: 'The AI tab opens — explanation of the sponsorship model + the toggle.',
      after: () => page.locator('[data-testid="workspace-ai-sponsoring-toggle"]').waitFor({ state: 'visible', timeout: 5_000 })
    }
  )

  // ─── Flip the toggle ────────────────────────────────────────────
  await flow.heading('Toggle AI sponsoring on', 3)
  await flow.narrate(
    'The toggle disables itself if you\'re not on Max or Ultra — no '
    + 'silent failure. As an admin on Max, it\'s active. Flip it.'
  )

  await flow.click(
    'Click the AI sponsoring toggle',
    page.locator('[data-testid="workspace-ai-sponsoring-toggle"]'),
    {
      hero: true,
      result: 'The workspace is now sponsored. The state line below '
        + 'flips to "members\' markoto use bills to your pool"; '
        + 'every workspace member\'s next AI call (prompt, @markoto '
        + 'mention, transcription) attributes to your interactions '
        + 'budget.',
      after: async () => {
        // The toggle does an optimistic flip + a background PUT to
        // /api/workspaces/:id which the parent re-fetches on success.
        // Wait for the visible state-line — when the current viewer
        // IS the billing owner the line reads `on your plan ·
        // members see the editor banner` (lowercased mono caption
        // in WorkspaceBillingToggle.vue).
        await expect(page.getByText(/on your plan/i).first()).toBeVisible({ timeout: 10_000 })
      }
    }
  )

  // ASSERTION: the workspace's `aiEnabled` is now true. Check via
  // the server's view, not just the optimistic UI — proves the
  // mutation actually committed.
  const wsCheck = await page.request.get(`/api/workspaces/${ws.workspaceId}`).then(r => r.json()) as { workspace: { aiEnabled: boolean, billingOwnerId: number | null } }
  expect(wsCheck.workspace.aiEnabled).toBe(true)
  expect(wsCheck.workspace.billingOwnerId).toBe(userId)

  flow.next({
    slug: 'knowledge-grounded-ai',
    why: 'Now upload reference docs to your sponsored workspace — every member\'s grounded AI calls are on you'
  })
})
