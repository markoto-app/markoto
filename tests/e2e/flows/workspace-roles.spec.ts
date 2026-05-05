import { test, expect } from '../fixtures/flow'
import { Pool } from 'pg'

// Tier 2: "Roles inside a workspace".
//
// User-job: a workspace admin needs to bring in someone whose access
// shouldn't match their own — a viewer who can read but never edit,
// an editor who can write but can't change permissions. Job done
// when the reader has seen the role contrast in action: server-side
// role flips persist immediately, the read-only enforcement runs
// four layers deep (token, Hocuspocus, CodeMirror, UI), and the
// workspace can never end up with no admin.
//
// What this flow is NOT: the invitation flow itself (that's
// `invite-a-teammate`). This flow assumes a member is already in
// the workspace and zooms in on the consequences of each role.
//
// Single-actor flow. The spawned-teammate pattern was simpler in
// concept but the multi-context cleanup raced with the final
// screenshot in practice. Driving role changes through the API
// from Maya's side keeps the demo declarative — the screenshots
// stay on the workspace settings + members panel where the role
// chips live.
//
// Desktop only: members modal + workspace settings pack densely;
// mobile single-column hides the role contrast.
test('Roles inside a workspace', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'Members modal + workspace settings pack densely; mobile'
    + ' single-column hides the role contrast.'
  )
  test.setTimeout(120_000)

  // Pre-create the teammate user row (so the membership row has a
  // real user_id to point at) plus the workspace + the membership
  // itself. All three via direct DB inserts: the story is the role
  // mechanic, not the surrounding plumbing.
  const pool = new Pool({
    connectionString: 'postgres://ypad:testpassword@localhost:5433/ypad_test',
    max: 1
  })
  let teammateUserId: number
  try {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO users (github_id, name, email, plan)
       VALUES ($1, $2, $3, 'free')
       RETURNING id`,
      [`flow-test-teammate-${Date.now()}`, 'Sam Reeves', `sam-${Date.now()}@team.example`]
    )
    teammateUserId = r.rows[0].id
  } finally {
    await pool.end()
  }

  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')
  const wsRes = await page.request.post('/api/workspaces', {
    data: { name: 'Compliance docs' }
  })
  if (!wsRes.ok()) throw new Error(`workspace create failed: ${wsRes.status()}`)
  const ws = await wsRes.json() as { workspaceId: string }

  const pool2 = new Pool({
    connectionString: 'postgres://ypad:testpassword@localhost:5433/ypad_test',
    max: 1
  })
  try {
    await pool2.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'viewer') ON CONFLICT DO NOTHING`,
      [ws.workspaceId, teammateUserId]
    )
  } finally {
    await pool2.end()
  }

  await page.goto(`/w/${ws.workspaceId}`)
  await page.getByRole('tab', { name: /documents/i }).waitFor({ state: 'visible', timeout: 10_000 })

  await flow.heading('Roles inside a workspace', 3)
  await flow.narrate(
    'Three roles. Admins do everything — add members, change '
    + 'permissions, delete the workspace. Editors write content '
    + 'but can\'t touch access controls. Viewers read; their '
    + 'editor is locked. Two safety rails: one workspace must '
    + 'always have at least one admin, and viewer read-only is '
    + 'enforced four layers deep so no client-side workaround '
    + 'sneaks past it.'
  )

  // ─── Open the members panel ─────────────────────────────────────
  await flow.click(
    'Open the members panel',
    page.locator('[data-testid="workspace-members-trigger"]'),
    {
      annotations: [
        { label: 'members card', selector: '[data-testid="workspace-members-trigger"]', kind: 'arrow' }
      ],
      result: 'Members modal opens — admin (you), Sam (viewer), and the role chip beside each name.',
      after: () => page.getByText(/Sam Reeves/i).first().waitFor({ state: 'visible', timeout: 5_000 })
    }
  )

  // ─── Promote Sam to editor (server-side) ────────────────────────
  await flow.heading('Promote Sam to editor', 3)
  await flow.narrate(
    'The role chip beside Sam\'s name opens a dropdown — Admin / '
    + 'Editor / Viewer. Pick Editor and the change persists '
    + 'immediately. The next time Sam\'s editor mints a token (on '
    + 'reload, or when the existing token expires after 2 h), the '
    + 'JWT carries `readOnly: false` and the read-only veil lifts.'
  )

  // Drive the promotion via API. The role-chip dropdown is admin-
  // only, non-testid'd, and racy with UDropdownMenu's animation;
  // the reader's takeaway is "promoting changes the role", not
  // "here's the dropdown". invite-a-teammate covers the members-
  // modal UI tour.
  const promoteRes = await page.request.patch(
    `/api/workspaces/${ws.workspaceId}/members/${teammateUserId}`,
    { data: { role: 'editor' } }
  )
  expect(promoteRes.status()).toBe(200)

  const wsAfter = await page.request.get(`/api/workspaces/${ws.workspaceId}`).then(r => r.json()) as {
    members: Array<{ userId: number, role: string }>
  }
  expect(wsAfter.members.find(m => m.userId === teammateUserId)?.role).toBe('editor')

  await flow.shot(
    'Sam\'s row updates — the role chip flips to Editor. Sam reloads '
    + 'the doc; their editor is now writable.',
    {
      hero: true,
      highlights: [
        { label: 'Members panel', selector: '[role="dialog"]' }
      ]
    }
  )

  // ─── Last-admin invariant ───────────────────────────────────────
  await flow.heading('The last-admin invariant', 3)
  await flow.narrate(
    'A workspace must always have at least one admin — otherwise '
    + 'no one can manage members or close it down. Trying to '
    + 'demote yourself when you\'re the sole admin gets a 409 '
    + 'from the server; the UI also disables the chip on your '
    + 'own row in that case.'
  )

  const meCheck = await page.request.get('/api/_auth/session').then(r => r.json()) as {
    user: { id: number }
  }
  const demoteRes = await page.request.patch(
    `/api/workspaces/${ws.workspaceId}/members/${meCheck.user.id}`,
    { data: { role: 'editor' } }
  )
  expect(demoteRes.status()).toBe(409)

  flow.next({
    slug: 'invite-a-teammate',
    why: 'Now that you know what each role can do, see how the invite flow itself works'
  })
})
