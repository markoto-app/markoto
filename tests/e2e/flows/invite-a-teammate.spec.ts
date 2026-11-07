import { test, expect } from '../fixtures/flow'

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
// EMAIL — not username — so the teammate's account is created with a
// known email and the SAME email goes into the invite form.
//
// Setup shortcut: the teammate's account (via the test login shim) and
// the workspace (via the API) skip the UI; the story is the invite
// mechanic, not the surrounding plumbing. Driving workspace creation
// through the UI is its own flow (`workspace-tour`).
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

  // Sam, the invitee: a second browser context with its own session. The
  // account carries a verified email — the address the invitation is
  // matched against — and the post-onboarding policy acceptance every
  // test user gets (otherwise the onboarding gate covers the dashboard).
  // The invitation is by EMAIL, never by username, so the SAME address
  // goes into the invite form below.
  // A clean, readable address — it is on screen in the invite form
  // and the pending-invite row. Several Sam accounts with this email
  // can exist across the suite's projects; the accept step below
  // targets THIS workspace's invite by id, so that's harmless.
  const teammateEmail = 'sam.reeves@team.example'
  const teammate = await flow.spawn('teammate')
  const { userId: teammateUserId } = await teammate.editor.loginAsTestUser('Sam Reeves', { email: teammateEmail })

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
    + 'others in, click "Invite people" at the top of the workspace '
    + 'page, type their email, pick a role (admin, editor, or '
    + 'viewer). Invitations are exact-email — no typeahead, so the '
    + 'directory isn\'t enumerable. Nobody joins until they accept.'
  )

  // ─── Open the Members panel ─────────────────────────────────────
  await flow.click(
    'Click "Invite people" at the top of the workspace page',
    page.locator('[data-testid="workspace-invite-people"]'),
    {
      annotations: [
        { label: 'invite people', selector: '[data-testid="workspace-invite-people"]', kind: 'arrow' }
      ],
      result: 'The Members modal opens with the email field ready — current roster + invite-by-email form.',
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

  const openInvites = await page.request.get(`/api/workspaces/${ws.workspaceId}/invites`).then(r => r.json()) as Array<{ inviteId: string, email: string }>
  const invite = openInvites.find(i => i.email === teammateEmail)
  expect(invite, 'no open invite for Sam').toBeTruthy()
  const inviteId = invite?.inviteId ?? ''

  await teammate.page.goto('/')
  const inviteList = teammate.page.locator('[data-testid="workspace-invite-list"]')
  await inviteList.waitFor({ state: 'visible', timeout: 15_000 })
  await teammate.flow.click(
    'Click Accept on the invitation',
    teammate.page.locator(`[data-testid="workspace-invite-accept-${inviteId}"]`),
    {
      hero: true,
      result: 'Sam is in, as an editor: the workspace now sits in My Workspaces on '
        + 'Sam\'s dashboard, ready to open.',
      after: () => teammate.page.locator(`[data-testid="workspace-list-item-${ws.workspaceId}"]`).waitFor({ state: 'visible', timeout: 15_000 }),
      highlights: [
        { label: 'Newly joined workspace', selector: `[data-testid="workspace-list-item-${ws.workspaceId}"]` }
      ]
    }
  )

  // ASSERTION (server-side): the membership exists only after accepting,
  // with the invited role.
  const membersAfter = await page.request.get(`/api/workspaces/${ws.workspaceId}`).then(r => r.json()) as {
    members: Array<{ userId: number, role: string }>
  }
  expect(membersAfter.members.some(m => m.userId === teammateUserId && m.role === 'editor')).toBe(true)

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
    slug: 'roles-inside-a-workspace',
    why: 'Decide who can edit, comment or manage the workspace'
  })
})
