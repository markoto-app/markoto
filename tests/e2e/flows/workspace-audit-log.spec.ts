import { Pool } from 'pg'
import { test, expect } from '../fixtures/flow'

// "See who changed what in a workspace".
//
// User-job: a workspace admin wants to check who changed the workspace's
// members and sharing — and keep a copy for their records. Job done when
// the audit log shows the real actions with who did them, one entry is
// opened, and the CSV download is offered.
//
// The events come from real actions through the API (a role change and a
// sharing change), so the flow also proves they land in the log. The
// flow stack runs the self-hosted free tier, which includes the audit
// log (on markoto.app it is Business only).

const DB_URL = 'postgres://ypad:testpassword@localhost:5433/ypad_test'

test('See who changed what in a workspace', async ({ page, flow, editor }) => {
  test.skip(editor.isMobile, 'the audit log is admin desk work')
  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')
  const wsRes = await page.request.post('/api/workspaces', { data: { name: 'Northwind research' } })
  expect(wsRes.ok(), await wsRes.text()).toBe(true)
  const { workspaceId } = await wsRes.json() as { workspaceId: string }

  // A colleague, then two real admin actions that the log records.
  const pool = new Pool({ connectionString: DB_URL, max: 1 })
  let benId: number
  try {
    const { rows } = await pool.query<{ id: number }>(`INSERT INTO users (github_id, name) VALUES ($1, 'Ben Ortiz') RETURNING id`, [`flow-audit-ben-${Date.now()}`])
    benId = rows[0]!.id
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'editor')`, [workspaceId, benId])
  } finally {
    await pool.end()
  }
  expect((await page.request.patch(`/api/workspaces/${workspaceId}/members/${benId}`, { data: { role: 'viewer' } })).ok()).toBe(true)
  const docRes = await page.request.post('/api/docs', { data: { workspaceId, title: 'Q3 board update', templateId: 'blank' } })
  expect(docRes.ok(), await docRes.text()).toBe(true)
  const { docId } = await docRes.json() as { docId: string }
  expect((await page.request.put(`/api/docs/${docId}/meta`, { data: { accessMode: 'open-view' } })).ok()).toBe(true)

  await page.goto(`/w/${workspaceId}`)
  await page.getByRole('tab', { name: /documents/i }).waitFor({ state: 'visible', timeout: 10_000 })

  await flow.heading('Open the audit log', 3)
  await flow.narrate(
    'The audit log lists what happened in the workspace, newest first: '
    + 'members and roles, invitations, sharing and deletions, billing and '
    + 'single sign-on — with who did it and their shortened network address.'
  )
  await flow.click(
    'Open the Audit log tab',
    page.getByRole('tab', { name: /audit log/i }),
    {
      chain: true,
      annotations: [{ label: 'Audit log', selector: '[role="tab"]:has-text("Audit log")', kind: 'arrow' }],
      after: () => page.getByTestId('workspace-audit-panel').locator('[data-testid^="workspace-audit-event-"]').first().waitFor({ state: 'visible', timeout: 10_000 })
    }
  )
  const panel = page.getByTestId('workspace-audit-panel')
  await expect(panel).toContainText('Role changed')
  await expect(panel).toContainText('Document sharing changed')
  await expect(panel).toContainText('Maya Chen')
  await flow.shot('Each change with when, what and who', {
    hero: true,
    highlights: [{ label: 'Who changed what', selector: '[data-testid="workspace-audit-panel"] [data-testid^="workspace-audit-event-"]' }]
  })

  await flow.step('Click an entry for its details', async () => {
    await panel.locator('[data-testid^="workspace-audit-event-"] button').filter({ hasText: 'Role changed' }).click()
    await expect(panel.getByTestId('workspace-audit-details')).toContainText('viewer')
  }, { highlights: [{ label: 'Before and after', selector: '[data-testid="workspace-audit-details"]' }] })

  await flow.heading('Download a copy', 3)
  await flow.shot('Download the selected events as CSV or JSON Lines', {
    highlights: [{ label: 'CSV', selector: '[data-testid="workspace-audit-export-csv"]' }]
  })
  const csv = await page.request.get(`/api/workspaces/${workspaceId}/audit/export?format=csv`)
  expect(csv.ok()).toBe(true)
  expect(await csv.text()).toContain('workspace.member_role_changed')

  flow.next({ slug: 'set-up-single-sign-on-for-a-workspace', why: 'Make everyone sign in through your organisation\'s identity provider.' })
})
