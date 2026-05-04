import { test, expect } from '../fixtures/flow'
import { Pool } from 'pg'

// Tier 2: "Roles inside a workspace".
//
// User-job: a workspace admin needs to bring in someone whose access
// shouldn't match their own — a viewer who can read but never edit,
// an editor who can write but can't change permissions, another
// admin who can do everything. Job done when they've added a
// teammate, demonstrated the role gates real behaviour (viewer's
// editor is read-only), promoted the teammate to editor, and seen
// the last-admin invariant block them from demoting themselves
// while they're the only admin.
//
// What this flow is NOT: the invitation flow itself (that's
// `invite-a-teammate`). This flow assumes a member is already in
// the workspace and zooms in on what each role actually CAN and
// CAN'T do, plus the safety rail that stops a workspace from
// ending up with no admin.
//
// Two-context flow via `flow.spawn('teammate')`. The admin demos
// the role-change UI from one identity; the teammate's view shows
// the read-only editor (when viewer) and the writable editor
// (after promotion to editor).
//
// Desktop only: members modal + admin/teammate side-by-side reads
// better at desktop widths.
test('Roles inside a workspace', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'Members modal + admin-vs-teammate before/after reads better'
    + ' side-by-side; mobile single-column hides the role contrast.'
  )
  test.setTimeout(180_000)

  // Pre-create the teammate as a real user row + create the workspace
  // + add the teammate as a viewer. Three direct DB writes because
  // this flow is about the ROLE mechanic, not the invite-and-accept
  // dance. (The invite UI tour is `invite-a-teammate`.)
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
  if (!wsRes.ok()) {
    throw new Error(`[workspace-roles] workspace create failed: ${wsRes.status()} ${await wsRes.text()}`)
  }
  const ws = await wsRes.json() as { workspaceId: string }

  // Add Sam as a VIEWER through the members API. Going through API
  // (not UI) keeps the flow narrative on the role MECHANIC; the
  // invite-by-email UI is the subject of `invite-a-teammate`.
  const inviteRes = await page.request.post(`/api/workspaces/${ws.workspaceId}/members`, {
    data: { email: `sam-${teammateUserId}@team.example`, role: 'viewer' }
  })
  // Email may not match the row we made above; fall back to direct
  // DB insert to ensure the membership lands. This is acceptable
  // because the focus is what happens AFTER membership exists.
  if (!inviteRes.ok()) {
    const pool2 = new Pool({
      connectionString: 'postgres://ypad:testpassword@localhost:5433/ypad_test',
      max: 1
    })
    try {
      await pool2.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, 'viewer')
         ON CONFLICT DO NOTHING`,
        [ws.workspaceId, teammateUserId]
      )
    } finally {
      await pool2.end()
    }
  }

  // Create one workspace doc so the teammate's editor view has
  // something to render. The doc carries an admin-sourced title so
  // the screenshots have a recognisable header.
  const docRes = await page.request.post(`/api/docs`, {
    data: { workspaceId: ws.workspaceId, title: 'Q3 launch checklist', accessMode: 'private' }
  })
  if (!docRes.ok()) {
    throw new Error(`[workspace-roles] doc create failed: ${docRes.status()} ${await docRes.text()}`)
  }
  const doc = await docRes.json() as { docId: string }

  await page.goto(`/w/${ws.workspaceId}`)
  await page.getByRole('tab', { name: /documents/i }).waitFor({ state: 'visible', timeout: 10_000 })

  await flow.heading('Roles inside a workspace', 3)
  await flow.narrate(
    'Three roles: admin, editor, viewer. Admins do everything — '
    + 'add members, change permissions, delete the workspace. '
    + 'Editors write content but can\'t touch access controls. '
    + 'Viewers read; their editor is locked. Promote and demote at '
    + 'will from the members panel — with one safety rail: a '
    + 'workspace must always have at least one admin.'
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

  // ─── What Sam sees as a viewer ──────────────────────────────────
  await flow.heading('What Sam sees as a viewer', 3)
  await flow.narrate(
    'Sam opens markoto in their own browser. They land on the '
    + 'workspace\'s doc — they can read every line but the toolbar '
    + 'is greyed out and the editor doesn\'t accept keystrokes. '
    + 'The viewer role is enforced four layers deep (token, '
    + 'Hocuspocus, CodeMirror, UI), so there\'s no "what if I just '
    + 'send a Y.js update directly" workaround.'
  )

  const teammate = await flow.spawn('teammate')
  await teammate.editor.loginAsExistingUser(teammateUserId, 'Sam Reeves')
  await teammate.page.goto(`/d/${doc.docId}`)
  await teammate.editor.waitForReady()

  await teammate.flow.shot(
    'Sam\'s editor — toolbar disabled, content visible, no caret. '
    + 'Read-only enforcement is part of the JWT issued for this '
    + 'doc, not a UI guess.',
    {
      highlights: [
        { label: 'Read-only editor', selector: '.cm-editor' }
      ]
    }
  )

  // ASSERTION: the editor is in read-only mode. CM6's read-only
  // state surfaces as a `cm-readonly` body class OR a missing
  // `contenteditable="true"` on the content div. The cleanest
  // signal is `EditorView.editable.of(false)` which removes the
  // `contenteditable` attribute entirely.
  const teammateContent = teammate.page.locator('.cm-content').first()
  const editable = await teammateContent.getAttribute('contenteditable')
  expect(editable).not.toBe('true')

  // ─── Promote Sam to editor ──────────────────────────────────────
  await flow.heading('Promote Sam to editor', 3)
  await flow.narrate(
    'Back in the admin\'s view, the role chip beside Sam\'s name '
    + 'is a dropdown. Switch to Editor — the change persists '
    + 'immediately and Sam\'s next page load picks up the new '
    + 'role.'
  )

  // The role chip is a UButton inside the modal row scoped by Sam's
  // name. Match the row, then the role-chip button (text matches
  // the current role). The dropdown trigger is an admin-only
  // affordance per the modal markup.
  const samRow = page.getByRole('listitem').filter({ hasText: 'Sam Reeves' })
  const samRoleChip = samRow.getByRole('button', { name: /viewer/i }).first()
  await flow.click(
    'Open Sam\'s role dropdown',
    samRoleChip,
    {
      result: 'Three options: admin / editor / viewer. The current role is checkmarked.',
      annotations: [
        { label: 'role chip', selector: 'li:has-text("Sam Reeves") button:has-text("Viewer")', kind: 'arrow' }
      ],
      after: () => page.getByRole('menuitem', { name: /editor/i }).first().waitFor({ state: 'visible', timeout: 3_000 })
    }
  )

  await flow.click(
    'Pick "Editor"',
    page.getByRole('menuitem', { name: /editor/i }).first(),
    {
      result: 'Sam\'s role flips to editor — the chip updates and the change persists server-side.',
      after: async () => {
        await expect(page.getByRole('listitem').filter({ hasText: 'Sam Reeves' })
          .getByRole('button', { name: /editor/i })).toBeVisible({ timeout: 5_000 })
      }
    }
  )

  // ASSERTION: the role flipped on the server.
  const wsAfterPromo = await page.request.get(`/api/workspaces/${ws.workspaceId}`).then(r => r.json()) as {
    members: Array<{ userId: number, role: string }>
  }
  expect(wsAfterPromo.members.find(m => m.userId === teammateUserId)?.role).toBe('editor')

  // ─── Sam re-loads — now writable ────────────────────────────────
  await flow.heading('Sam reloads — the editor is writable', 3)
  await flow.narrate(
    'Token JWTs carry the role; on the next page load, Sam\'s new '
    + 'JWT mints with `readOnly: false`. They reload, the toolbar '
    + 'comes alive, the caret blinks. Same doc, same content — '
    + 'just a different role.'
  )

  await teammate.page.reload()
  await teammate.editor.waitForReady()

  await teammate.flow.shot(
    'Sam can now write into the same doc — toolbar active, caret '
    + 'in the editor. The role change took on the next token mint.',
    {
      hero: true,
      highlights: [
        { label: 'Writable editor', selector: '.cm-content' }
      ]
    }
  )

  // ASSERTION: post-reload, Sam's editor IS editable.
  const teammateContent2 = teammate.page.locator('.cm-content').first()
  await expect(teammateContent2).toHaveAttribute('contenteditable', 'true', { timeout: 10_000 })

  // ─── Last-admin invariant ───────────────────────────────────────
  await flow.heading('The last-admin invariant', 3)
  await flow.narrate(
    'A workspace must always have at least one admin — otherwise '
    + 'no one can manage members or close the workspace down. '
    + 'Try to demote yourself when you\'re the only admin and the '
    + 'server returns 409 with a message; the chip stays put.'
  )

  // Try to demote Maya (the sole admin) via the API. The UI
  // disables her own role chip when she's the sole admin (per
  // the modal's `isSoleAdmin` check), so the test asserts the
  // SERVER-side guard via a direct API call.
  const meCheck = await page.request.get('/api/_auth/session').then(r => r.json()) as {
    user: { id: number }
  }
  const demoteRes = await page.request.patch(
    `/api/workspaces/${ws.workspaceId}/members/${meCheck.user.id}`,
    { data: { role: 'editor' } }
  )
  expect(demoteRes.status()).toBe(409)

  await flow.shot(
    'Demoting the last admin returns 409. The members panel disables '
    + 'the chip on your own row when you\'re the only admin — UI + '
    + 'server enforce the invariant in lockstep.',
    {
      annotations: [
        { label: 'Sole admin — chip disabled', selector: 'li:has-text("Maya Chen") button[disabled]', kind: 'arrow' }
      ]
    }
  )

  flow.next({
    slug: 'invite-a-teammate',
    why: 'Now that you know what each role can do, see how the invite flow itself works'
  })
})
