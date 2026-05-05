import { test, expect } from '../fixtures/flow'

// Tier 1: "Start a workspace for your team".
//
// User-job: a writer who's been working in solo docs hits the moment
// where they want a SHARED place — a team's RFCs, a class's notes, a
// company's onboarding library. Job done when they've created a
// workspace from the dashboard, named it, and landed on the
// workspace's home page where they can start filing docs into it.
//
// What this flow is NOT: a full tour of workspaces. It does not cover
// inviting members (covered separately by `password-protect`'s
// permission story shape, and by future invite-flow tier-2 work),
// admin/editor/viewer roles (separate flow candidate), the AI
// sponsoring `(+)` mechanic (billing-tier-dependent, deferred),
// or moving a doc INTO a workspace (covered indirectly by
// `knowledge-grounded-ai` which creates a workspace doc).
//
// Why a Tier-1 flow: workspace creation is the most-requested
// "where do I start" question for teams. Without this tour, a
// reader has to discover the dashboard's "+ New workspace" button
// + the WorkspaceFormModal on their own. With it, the entry point
// is a click on the docs site.
//
// Desktop-focused: the dashboard's two-column layout (workspaces +
// recent docs) is wider than mobile single-column, and the
// before/after of "the workspace appears in the list" reads more
// clearly with both columns visible.
test('Start a workspace', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'Workspace tour reads better at desktop where the dashboard\'s'
    + ' workspace list + recent docs columns sit side-by-side; mobile'
    + ' stacks them and the "your workspace appears in the list"'
    + ' before/after is below the fold.'
  )
  test.setTimeout(120_000)

  // Login first — the dashboard's "+ New workspace" button only
  // appears for logged-in users (anonymous users see only the
  // "+ New document" CTA).
  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')

  await flow.heading('Start a workspace for your team', 3)
  await flow.narrate(
    'A workspace is a shared place for related docs — a team\'s '
    + 'RFCs, a class\'s notes, a company\'s onboarding library. '
    + 'Members get role-based access (admin, editor, viewer). The '
    + 'workspace also has its own knowledge base — drop in PDFs, '
    + 'Word docs, FAQs and the AI grounds its answers in those '
    + 'files when working on any doc inside the workspace.'
  )

  // ─── Open the create-workspace modal ────────────────────────────
  await flow.heading('Click "+ New workspace"', 3)
  await flow.narrate(
    'The dashboard\'s top-right CTA pair is "+ New document" + '
    + '"+ New workspace". Click the second to open the create dialog.'
  )

  await flow.click(
    'Click the "+ New workspace" button',
    page.locator('[data-testid="landing-new-workspace"]'),
    {
      annotations: [
        { label: 'new workspace', selector: '[data-testid="landing-new-workspace"]', kind: 'arrow' }
      ],
      result: 'A modal opens — name + optional description, that\'s the whole form.',
      after: () => page.locator('[data-testid="workspace-form-name"]').waitFor({ state: 'visible', timeout: 5_000 })
    }
  )

  // ─── Fill the form ──────────────────────────────────────────────
  await flow.heading('Name your workspace', 3)
  await flow.narrate(
    'The name shows in the topbar of every doc in the workspace + '
    + 'in the dashboard list. The description is optional but '
    + 'shows up in the workspace card — useful when you have '
    + 'several workspaces with similar names.'
  )

  await flow.type(
    'Type a name',
    page.locator('[data-testid="workspace-form-name"]'),
    'Q3 launch — engineering retro',
    { result: 'The name lands. Submit is now enabled.' }
  )

  await flow.type(
    'Add a one-line description',
    page.locator('[data-testid="workspace-form-description"]'),
    'Postmortem docs, action items, and the team RFC index.',
    { result: 'The description is captured.' }
  )

  // ─── Submit + land on the workspace ─────────────────────────────
  await flow.heading('Create + land on the workspace', 3)
  await flow.narrate(
    'Submit creates the workspace, makes you the admin, and routes '
    + 'you to its home page. The URL is `/w/{nanoid}` — share it and '
    + 'others see the workspace exists, but they can\'t join until '
    + 'an admin invites them.'
  )

  await flow.click(
    'Click "Create"',
    page.locator('[data-testid="workspace-form-submit"]'),
    {
      hero: true,
      result: 'You land on the workspace home page — empty Documents + '
        + 'Knowledge tabs, ready for content. The topbar carries the '
        + 'workspace name; you\'re the admin (visible in the members '
        + 'list once we add some).',
      after: async () => {
        await page.waitForURL(/\/w\/[A-Za-z0-9_-]+/, { timeout: 10_000 })
        // Wait for the workspace landing page to actually render —
        // the tabs are the cleanest "page rendered" signal.
        await page.getByRole('tab', { name: /documents/i }).waitFor({ state: 'visible', timeout: 10_000 })
      },
      highlights: [
        { label: 'Workspace tabs', selector: '[role="tablist"]' }
      ]
    }
  )

  // ASSERTION: we're on a workspace URL with a non-empty nanoid +
  // the workspace name shows somewhere on the page.
  expect(page.url()).toMatch(/\/w\/[A-Za-z0-9_-]{6,}/)
  await expect(page.getByText(/Q3 launch — engineering retro/i).first()).toBeVisible()

  flow.next({
    slug: 'knowledge-grounded-ai',
    why: 'Workspaces shine when you upload reference docs and let the AI ground its answers in them'
  })
})
