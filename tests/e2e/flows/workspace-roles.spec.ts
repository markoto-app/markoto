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
// Single-actor flow: Maya (admin) changes Sam's role through the
// role chip in the members modal — the same click a real admin makes —
// and the chip, the server and the last-admin rail are all asserted.
//
// Runs on desktop AND mobile. The members modal renders identically
// at both viewport widths (Reka UI dialog reflows under `<sm`).
test('Roles inside a workspace', async ({ page, flow, editor }) => {
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
      // Clean display email — it is on screen in the members modal.
      [`flow-test-teammate-${Date.now()}`, 'Sam Reeves', 'sam.reeves@team.example']
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
    + 'always have at least one admin, and a viewer\'s read-only '
    + 'access is enforced by the server, not just hidden in the UI.'
  )

  // Open the members panel
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
  const samChip = page.locator(`[data-testid="workspace-member-row-${teammateUserId}"] [data-testid="workspace-member-role"]`)
  await expect(samChip).toContainText('Viewer')

  // Promote Sam to editor (server-side)
  await flow.heading('Promote Sam to editor', 3)
  await flow.narrate(
    'The role chip beside Sam\'s name opens a dropdown — Admin / '
    + 'Editor / Viewer. Pick Editor and the change is saved right away. '
    + 'Sam\'s documents become writable the next time they open one '
    + '(an editor that is already open picks it up within two hours).'
  )

  await flow.click(
    'Click the role chip beside Sam',
    samChip,
    {
      result: 'The role menu opens — Admin, Editor, Viewer.',
      after: () => page.getByRole('menuitem', { name: /^editor/i }).waitFor({ state: 'visible' })
    }
  )
  await flow.click(
    'Pick "Editor"',
    page.getByRole('menuitem', { name: /^editor/i }),
    {
      hero: true,
      result: 'Sam\'s chip now reads Editor — the change is saved.',
      highlights: [
        { label: 'Sam is now an editor', selector: `[data-testid="workspace-member-row-${teammateUserId}"]` }
      ],
      after: () => expect(samChip).toContainText('Editor')
    }
  )

  const wsAfter = await page.request.get(`/api/workspaces/${ws.workspaceId}`).then(r => r.json()) as {
    members: Array<{ userId: number, role: string }>
  }
  expect(wsAfter.members.find(m => m.userId === teammateUserId)?.role).toBe('editor')

  // Last-admin invariant
  await flow.heading('The last-admin invariant', 3)
  await flow.narrate(
    'A workspace must always have at least one admin — otherwise '
    + 'no one can manage members or close it down. While you are '
    + 'the only admin, the role chip on your own row is locked, and '
    + 'markoto refuses the change even if something tries it anyway.'
  )

  const meCheck = await page.request.get('/api/_auth/session').then(r => r.json()) as {
    user: { id: number }
  }
  const myChip = page.locator(`[data-testid="workspace-member-row-${meCheck.user.id}"] [data-testid="workspace-member-role"]`)
  await expect(myChip).toBeDisabled()
  await flow.shot('Your own role chip is locked — you are the only admin.', {
    highlights: [
      { label: 'Locked: last admin', selector: `[data-testid="workspace-member-row-${meCheck.user.id}"] [data-testid="workspace-member-role"]` }
    ]
  })
  const demoteRes = await page.request.patch(
    `/api/workspaces/${ws.workspaceId}/members/${meCheck.user.id}`,
    { data: { role: 'editor' } }
  )
  expect(demoteRes.status()).toBe(409)

  flow.next({
    slug: 'invite-a-teammate-to-your-workspace',
    why: 'Now that you know what each role can do, see how the invite flow itself works'
  })
})
