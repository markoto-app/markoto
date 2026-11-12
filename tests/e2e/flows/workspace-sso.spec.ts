import { Pool } from 'pg'
import { test, expect } from '../fixtures/flow'
import { PRIVACY_VERSION, TOS_VERSION } from '../../../shared/legal/versions'

// "Set up single sign-on for a workspace".
//
// User-job: an IT-minded workspace admin wants everyone to sign in to the
// workspace through the company's identity provider. Job done when the
// connection is ON (after a test sign-in with their own account) and a
// colleague who opens the workspace is sent to the organisation's
// sign-in.
//
// The identity provider is the stack's mock OpenID provider (`oidc-test`,
// navikt mock-oauth2-server) on the test network's private address, the
// server refuses loopback IdPs, and the flow stack allows private ones
// (NUXT_SSO_ALLOW_PRIVATE_URLS). Its login page takes a user name and
// the claims to put in the token. Domain verification needs a real DNS
// TXT record, so the flow marks the domain verified in the database
// after showing the instruction.
//
// The flow stack runs the self-hosted free tier, which includes single
// sign-on (on markoto.app it is Business only). Desktop only: setting up
// an IdP is desk work, and the IdP's page is not part of markoto.

const DB_URL = 'postgres://ypad:testpassword@localhost:5433/ypad_test'
const IDP_HOST = process.env.TEST_FAKE_OPENAI_HOST || process.env.TEST_NETWORK_GATEWAY || '10.213.47.1'

test('Set up single sign-on for a workspace', async ({ page, flow, editor }) => {
  test.skip(editor.isMobile, 'identity-provider setup is desktop work')
  test.setTimeout(120_000)
  const issuer = `http://${IDP_HOST}:4130/northwind-${Date.now()}`

  // Setup: Maya's workspace with a colleague
  const maya = await editor.page.loginAsTestUser('Maya Chen', { email: 'maya@northwind.example' })
  await page.goto('/')
  const wsRes = await page.request.post('/api/workspaces', { data: { name: 'Northwind research' } })
  expect(wsRes.ok(), await wsRes.text()).toBe(true)
  const { workspaceId } = await wsRes.json() as { workspaceId: string }
  const pool = new Pool({ connectionString: DB_URL, max: 1 })
  let benId: number
  try {
    // A colleague who already uses markoto (policies accepted).
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO users (github_id, name, email, age_confirmed_at,
         privacy_version_accepted, privacy_version_accepted_locale, tos_version_accepted, tos_version_accepted_locale)
       VALUES ($1, 'Ben Ortiz', 'ben@northwind.example', now(), $2, 'en', $3, 'en') RETURNING id`,
      [`flow-sso-ben-${Date.now()}`, PRIVACY_VERSION, TOS_VERSION]
    )
    benId = rows[0]!.id
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'editor')`, [workspaceId, benId])
  } finally {
    await pool.end()
  }

  await page.goto(`/w/${workspaceId}`)
  await page.getByRole('tab', { name: /documents/i }).waitFor({ state: 'visible', timeout: 10_000 })

  // Connect the identity provider
  await flow.heading('Connect your identity provider', 3)
  await flow.narrate(
    'Workspace admins find single sign-on in its own tab. Choose OpenID '
    + 'Connect or SAML and enter what your identity provider gave you '
    + 'when you registered markoto there.'
  )
  await flow.click(
    'Open the Single sign-on tab',
    page.getByRole('tab', { name: /single sign-on/i }),
    {
      chain: true,
      annotations: [{ label: 'Single sign-on', selector: '[role="tab"]:has-text("Single sign-on")', kind: 'arrow' }],
      after: () => page.getByTestId('workspace-sso-panel').waitFor({ state: 'visible', timeout: 10_000 })
    }
  )
  await flow.step('Enter the issuer URL, client ID and client secret', async () => {
    await page.getByTestId('workspace-sso-oidc-issuer').fill(issuer)
    await page.getByTestId('workspace-sso-oidc-client-id').fill('markoto')
    await page.getByTestId('workspace-sso-oidc-client-secret').fill('northwind-client-secret')
  }, { highlights: [{ label: 'Identity provider', selector: '[data-testid="workspace-sso-oidc-issuer"]' }] })
  await flow.click(
    'Save',
    page.getByTestId('workspace-sso-save'),
    {
      result: 'markoto shows the redirect URI to enter at your identity provider. Single sign-on is not switched on yet.',
      after: () => page.getByTestId('workspace-sso-sp').waitFor({ state: 'visible', timeout: 10_000 })
    }
  )
  await expect(page.getByTestId('workspace-sso-status')).toContainText(/not switched on/i)
  await flow.shot('Copy the redirect URI into your identity provider\'s app settings', {
    highlights: [{ label: 'Redirect URI', selector: '[data-testid="workspace-sso-sp-callback"]' }]
  })

  // Verify the email domain
  await flow.heading('Verify your email domain', 3)
  await flow.narrate(
    'Only addresses in a domain you verify are linked to existing '
    + 'markoto accounts or join the workspace on their first sign-in. '
    + 'markoto gives you a TXT record to publish in that domain\'s DNS.'
  )
  await flow.step('Add your domain', async () => {
    await page.getByTestId('workspace-sso-domain-input').fill('northwind.example')
    await page.getByTestId('workspace-sso-domain-add').click()
    await page.getByTestId('workspace-sso-domain-northwind.example').waitFor({ state: 'visible', timeout: 10_000 })
  }, { highlights: [{ label: 'TXT record', selector: '[data-testid="workspace-sso-domain-northwind.example"]' }] })
  // No real DNS here: the record counts as published.
  const verifyPool = new Pool({ connectionString: DB_URL, max: 1 })
  try {
    // A domain is verified by one workspace only; earlier runs (the other
    // colour variant) used the same name.
    await verifyPool.query(`DELETE FROM sso_domains WHERE domain = 'northwind.example' AND workspace_id <> $1`, [workspaceId])
    await verifyPool.query(`UPDATE sso_domains SET verified_at = now() WHERE workspace_id = $1`, [workspaceId])
  } finally {
    await verifyPool.end()
  }

  // Test the sign-in: this switches it on
  await flow.heading('Test the sign-in to switch it on', 3)
  await flow.narrate(
    'Sign in once through your identity provider with your own account. '
    + 'When that works, single sign-on is switched on, so a typo in the '
    + 'settings can never lock your team out.'
  )
  // The approach frame only: the next page is the mock IdP's own login
  // form, which looks nothing like the reader's real provider.
  await flow.shot('Click "Test sign-in and switch on" and sign in at your identity provider as usual', {
    annotations: [{ label: 'Test sign-in', selector: '[data-testid="workspace-sso-test"]', kind: 'arrow' }]
  })
  await page.getByTestId('workspace-sso-test').click()
  await page.waitForURL(url => url.port === '4130', { timeout: 15_000 })
  await page.locator('input[name="username"]').fill(`maya-${maya.userId}`)
  await page.locator('textarea[name="claims"]').fill(JSON.stringify({ email: 'maya@northwind.example', email_verified: true, name: 'Maya Chen' }))
  await page.locator('input[type="submit"], button[type="submit"]').first().click()
  await page.waitForURL(url => url.pathname === `/w/${workspaceId}`, { timeout: 20_000 })
  await page.getByRole('tab', { name: /single sign-on/i }).click()
  await expect(page.getByTestId('workspace-sso-status')).toContainText(/^on$/i, { timeout: 10_000 })
  await editor.page.dismissToasts()
  await flow.shot('Single sign-on is on for the workspace', {
    hero: true,
    highlights: [
      { label: 'On', selector: '[data-testid="workspace-sso-status"]' },
      { label: 'Members sign in through your identity provider', selector: '[data-testid="workspace-sso-enforced"]' }
    ]
  })

  // A colleague opens the workspace
  await flow.heading('Your colleagues sign in through your organisation', 3)
  const ben = await flow.spawn('colleague')
  await ben.editor.loginAsExistingUser(benId, 'Ben Ortiz')
  await ben.page.goto(`/w/${workspaceId}`)
  await ben.page.getByTestId('workspace-sso-required').waitFor({ state: 'visible', timeout: 10_000 })
  await ben.flow.shot('Ben opens the workspace and is asked to sign in with the organisation', {
    highlights: [{ label: 'Sign in with your organisation', selector: '[data-testid="workspace-sso-sign-in"]' }]
  })

  flow.next({ slug: 'put-a-workspace-on-the-team-plan', why: 'Add seats and a shared AI budget for the whole workspace.' })
})
