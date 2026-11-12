import { Pool } from 'pg'
import { test, expect } from '../fixtures/flow'
import { PRIVACY_VERSION, TOS_VERSION } from '../../../shared/legal/versions'

// "Share a document with a guest".
//
// User-job: a workspace admin wants a client to review ONE document
// without letting them into the rest of the workspace. Job done when the
// client — signed in as a guest of the workspace in their own browser —
// finds the document under "Shared with you" and opens it, and the
// workspace itself stays closed to them.
//
// The client joined as a guest beforehand (seeded); the invitation step
// is narrated. The flow stack runs the self-hosted free tier, which
// includes guests (on markoto.app: Team and Business).

const DB_URL = 'postgres://ypad:testpassword@localhost:5433/ypad_test'

test('Share a document with a guest', async ({ page, flow, editor }) => {
  test.skip(editor.isMobile, 'sharing with guests is set up at a desk')
  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')
  const wsRes = await page.request.post('/api/workspaces', { data: { name: 'Northwind research' } })
  expect(wsRes.ok(), await wsRes.text()).toBe(true)
  const { workspaceId } = await wsRes.json() as { workspaceId: string }

  const pool = new Pool({ connectionString: DB_URL, max: 1 })
  let clientId: number
  try {
    // The client: an existing markoto account, a guest of the workspace.
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO users (github_id, name, email, age_confirmed_at,
         privacy_version_accepted, privacy_version_accepted_locale, tos_version_accepted, tos_version_accepted_locale)
       VALUES ($1, 'Lena Fischer', 'lena@harbourline.example', now(), $2, 'en', $3, 'en') RETURNING id`,
      [`flow-guest-lena-${Date.now()}`, PRIVACY_VERSION, TOS_VERSION]
    )
    clientId = rows[0]!.id
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'guest')`, [workspaceId, clientId])
  } finally {
    await pool.end()
  }

  const docRes = await page.request.post('/api/docs', {
    data: {
      workspaceId,
      title: 'Harbourline proposal',
      // eslint-disable-next-line markoto/no-milestone-vocabulary -- sample document text, not a project label
      content: '# Harbourline proposal\n\n## Scope\n\nA shared routing model for the three Harbourline depots, delivered in two phases.\n\n## Timeline\n\n- Phase 1: data and model, six weeks\n- Phase 2: rollout and training, four weeks\n'
    }
  })
  expect(docRes.ok(), await docRes.text()).toBe(true)
  const { docId } = await docRes.json() as { docId: string }
  await page.goto(`/d/${docId}`)
  await editor.page.waitForReady()

  await flow.heading('Share one document with a guest', 3)
  await flow.narrate(
    'A guest is someone outside your team — a client, a freelancer — whom '
    + 'you invite to the workspace with the role "Guest". A guest sees only '
    + 'the documents you share with them, takes no seat, and uses their own '
    + 'AI budget. Lena from Harbourline already accepted her invitation.'
  )
  await flow.click(
    'Open the share dialog',
    editor.page.accessLockButton,
    {
      chain: true,
      annotations: [{ label: 'Share', selector: '[aria-label*="access mode" i]', kind: 'arrow' }],
      after: () => page.getByTestId('share-guests').waitFor({ state: 'visible', timeout: 10_000 })
    }
  )

  await flow.step('Choose the guest and what they may do', async () => {
    await page.getByTestId('share-guest-pick').click()
    await page.getByRole('option', { name: /Lena Fischer/ }).click()
    await page.getByTestId('share-guest-pick-access').click()
    await page.getByRole('option', { name: /can edit/i }).click()
  }, { highlights: [{ label: 'Guests of the workspace', selector: '[data-testid="share-guests"]' }] })

  await flow.click(
    'Share',
    page.getByTestId('share-guest-add'),
    { chain: true, after: () => page.getByTestId(`share-guest-${clientId}`).waitFor({ state: 'visible', timeout: 10_000 }) }
  )
  await expect(page.getByTestId(`share-guest-${clientId}`)).toContainText('Lena Fischer')
  await flow.shot('Lena can now edit this document — and only this one', {
    highlights: [{ label: 'Shared with Lena', selector: `[data-testid="share-guest-${clientId}"]` }]
  })

  // The guest's view
  await flow.heading('What the guest sees', 3)
  const lena = await flow.spawn('guest')
  await lena.editor.loginAsExistingUser(clientId, 'Lena Fischer')
  await lena.page.goto('/')
  await lena.page.getByTestId('home-shared-documents').waitFor({ state: 'visible', timeout: 10_000 })
  await expect(lena.page.getByTestId('home-shared-documents')).toContainText('Harbourline proposal')
  await expect(lena.page.getByTestId('home-shared-documents')).toContainText('Northwind research')
  await lena.flow.shot('Lena finds the document under "Shared with you"', {
    hero: true,
    highlights: [{ label: 'Shared with you', selector: '[data-testid="home-shared-documents"]' }]
  })
  await lena.flow.click(
    'Open it',
    lena.page.getByTestId(`home-shared-document-${docId}`),
    { chain: true, after: () => lena.page.waitForURL(`**/d/${docId}`) }
  )
  await lena.editor.waitForReady()
  await lena.flow.shot('She edits it like any document')

  // The rest of the workspace stays closed.
  expect((await lena.page.request.get(`/api/workspaces/${workspaceId}`)).status()).toBe(404)

  flow.next({ slug: 'see-who-changed-what-in-a-workspace', why: 'Every share and unshare is recorded in the workspace\'s audit log.' })
})
