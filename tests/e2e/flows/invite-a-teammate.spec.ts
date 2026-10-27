import { test, expect } from '../fixtures/flow'
import { Pool } from 'pg'

// Tier 2: "Invite a teammate to your workspace".
//
// User-job: an admin who just created a workspace wants to add a
// coworker so they can both file docs into it. Job done when the
// admin types the coworker's email + role, hits Invite, and the
// coworker (separate browser, fresh login) accepts the invitation
// from their dashboard and sees the workspace in My Workspaces.
//
// Two-context flow via `flow.spawn('teammate')`. The admin invites
// from one identity (a PENDING invitation — nobody joins without
// accepting); the teammate signs in with the invited email, finds the
// invitation on their dashboard and accepts it. The invitation is by
// EMAIL — not username — so we pre-create the teammate's user row with
// a known email and pass the SAME email to the invite form.
//
// Setup shortcut: workspace + teammate user row are created via
// direct DB INSERT; the story is the invite mechanic, not the
// surrounding plumbing. Driving workspace creation through the UI
// is its own flow (`workspace-tour`).
//
// Runs on desktop AND mobile. Same workspace landing page →
// `WorkspaceMemberAvatars` (no responsive hide) → members modal
// (Reka UI, mobile-friendly width) → invite-by-email form. Mobile
// stacks the dashboard's "My Workspaces" section vertically rather
// than side-by-side, so the before/after lands one card below the
// fold instead of next to its neighbour, but the assertion + screenshot
// still capture the invited workspace card directly.
test('Invite a teammate to your workspace', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Pre-create the teammate's user row with a known email. Direct
  // INSERT because `loginAsTestUser` doesn't take an email argument
  // (its shape is name + plan; email is set during real OAuth from
  // the GitHub/Google profile, not by the test shim).
  const teammateEmail = `sam-reeves-${Date.now()}@team.example`
  const pool = new Pool({
    connectionString: 'postgres://ypad:testpassword@localhost:5433/ypad_test',
    max: 1
  })
  let teammateUserId: number
  try {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO users (github_id, name, email, plan)
       VALUES ($1, $2, $3, 'free')
       ON CONFLICT (github_id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
       RETURNING id`,
      [`flow-test-teammate-${Date.now()}`, 'Sam Reeves', teammateEmail]
    )
    teammateUserId = r.rows[0].id
  } finally {
    await pool.end()
  }

  // Maya (the admin) logs in + creates the workspace via API.
  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')
  const wsRes = await page.request.post('/api/workspaces', {
    data: { name: 'Q3 launch — engineering retro' }
  })
  if (!wsRes.ok()) {
    throw new Error(`[invite] workspace create failed: ${wsRes.status()} ${await wsRes.text()}`)
  }
  const ws = await wsRes.json() as { workspaceId: string }
  await page.goto(`/w/${ws.workspaceId}`)
  await page.getByRole('tab', { name: /documents/i }).waitFor({ state: 'visible', timeout: 10_000 })

  await flow.heading('Invite a teammate to your workspace', 3)
  await flow.narrate(
    'Workspaces start with one member — you, the admin. To bring '
    + 'others in, open the members panel from the workspace home '
    + 'page, type their email, pick a role (admin, editor, or '
    + 'viewer). Invitations are exact-email — no typeahead, so the '
    + 'directory isn\'t enumerable. Nobody joins until they accept.'
  )

  // ─── Open the Members panel ─────────────────────────────────────
  await flow.click(
    'Click the members card on the workspace home page',
    page.locator('[data-testid="workspace-members-trigger"]'),
    {
      annotations: [
        { label: 'members card', selector: '[data-testid="workspace-members-trigger"]', kind: 'arrow' }
      ],
      result: 'The Members modal opens — current roster + invite-by-email form.',
      after: () => page.locator('[data-testid="workspace-invite-email"]').waitFor({ state: 'visible', timeout: 5_000 })
    }
  )

  // ─── Invite Sam ─────────────────────────────────────────────────
  await flow.heading('Add Sam by email', 3)
  await flow.narrate(
    'Type the exact email Sam signed up with. The default role is '
    + '"editor" — they can read, write, comment, but can\'t change '
    + 'access controls or remove other members. Switch to "viewer" '
    + 'for read-only access or "admin" to delegate full control.'
  )

  await flow.type(
    'Type Sam\'s email',
    page.locator('[data-testid="workspace-invite-email"]'),
    teammateEmail,
    { result: 'The email is staged. Hit Invite to send the invitation.' }
  )

  await flow.click(
    'Click Invite',
    page.locator('[data-testid="workspace-invite-submit"]'),
    {
      result: 'The invitation is pending — listed under the roster with its role and expiry until Sam accepts.',
      after: async () => {
        await expect(page.locator(`[data-testid="workspace-pending-invite-${teammateEmail}"]`)).toBeVisible({ timeout: 10_000 })
      }
    }
  )

  // ASSERTION (server-side): NOT a member yet — the invitation is
  // pending until Sam accepts it.
  const membersBefore = await page.request.get(`/api/workspaces/${ws.workspaceId}`).then(r => r.json()) as {
    members: Array<{ userId: number, role: string }>
  }
  expect(membersBefore.members.some(m => m.userId === teammateUserId)).toBe(false)

  // ─── Sam sees the workspace ────────────────────────────────────
  await flow.heading('Sam accepts', 3)
  await flow.narrate(
    'Sam opens markoto in their own browser, signed in with the invited '
    + 'email. The invitation waits under Invitations on their dashboard — '
    + 'workspace name, role and who invited them. (Where email is set up, '
    + 'Sam also gets an invitation email with a one-time link.)'
  )

  // Spawn Sam — fresh BrowserContext, separate identity. Their
  // session has to map to the SAME user row we pre-created above
  // (so the invite finds them). `loginAsTestUser` would create a
  // NEW user keyed on a fresh github_id; use `loginAsExistingUser`
  // to seal a session against the pre-existing id instead.
  const teammate = await flow.spawn('teammate')
  await teammate.editor.loginAsExistingUser(teammateUserId, 'Sam Reeves')

  await teammate.page.goto('/')
  const inviteList = teammate.page.locator('[data-testid="workspace-invite-list"]')
  await inviteList.waitFor({ state: 'visible', timeout: 15_000 })
  await teammate.flow.click(
    'Click Accept on the invitation',
    inviteList.getByRole('button', { name: /accept/i }).first(),
    {
      result: 'Sam joins as an editor; the workspace moves into My Workspaces.',
      after: () => teammate.page.locator(`[data-testid="workspace-list-item-${ws.workspaceId}"]`).waitFor({ state: 'visible', timeout: 15_000 })
    }
  )

  // ASSERTION (server-side): the membership exists only after accepting,
  // with the invited role.
  const membersAfter = await page.request.get(`/api/workspaces/${ws.workspaceId}`).then(r => r.json()) as {
    members: Array<{ userId: number, role: string }>
  }
  expect(membersAfter.members.some(m => m.userId === teammateUserId && m.role === 'editor')).toBe(true)

  await teammate.flow.shot(
    'Sam\'s dashboard — the workspace you just shared sits in their '
    + 'My Workspaces section, ready to click into.',
    {
      hero: true,
      highlights: [
        { label: 'Newly invited workspace', selector: `[data-testid="workspace-list-item-${ws.workspaceId}"]` }
      ]
    }
  )

  // ASSERTION: Sam's dashboard contains the workspace card AND it
  // surfaces as an INVITED workspace (role=editor), not an owned
  // one. Without the role check the test would still pass if Sam
  // was somehow created as the owner — which would be the wrong
  // thing the right test would catch. The card carries
  // `data-role="editor"` from WorkspaceList; assert directly.
  const teammateCard = teammate.page.locator(`[data-testid="workspace-list-item-${ws.workspaceId}"]`)
  await expect(teammateCard).toBeVisible()
  await expect(teammateCard).toHaveAttribute('data-role', 'editor')

  flow.next({
    slug: 'let-your-team-use-the-ai-on-your-dime',
    why: 'Now that the team is in, sponsor their AI use against your plan'
  })
})
