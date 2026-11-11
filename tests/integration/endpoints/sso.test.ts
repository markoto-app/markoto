import { randomBytes } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { ssoMockIdpBase, TEST_BASE_URL, TEST_BILLING_OFF_BASE_URL } from '../setup/env'
import { authnRequestId, makeIdpKeyPair, samlResponse, type IdpKeyPair } from '../setup/samlIdp'
import { PRIVACY_VERSION, TOS_VERSION } from '~~/shared/legal/versions'

// Per-workspace single sign-on, end to end through the Nitro
// server:
//   - OIDC against the REAL mock IdP (`oidc-test`, every path an issuer),
//     reached on the test network's private address (the SSO fetch policy
//     refuses loopback; the test server allows private IdPs);
//   - SAML with responses signed in-process (`setup/samlIdp.ts`), so the
//     tests can also send the malformed ones a real IdP never would.
// Covers: settings (no secret leaves the server, SSRF guard, plan gate),
// test sign-in → activation, enforcement on every access path, linking
// only for verified domains, JIT joins, grants voided by "log out
// everywhere", the admin break-glass.

const FLOW_COOKIE = 'markoto-sso-flow'
const SESSION_COOKIE = 'nuxt-session'

function cookieValue(res: Response, name: string): string | null {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    const eq = pair?.indexOf('=') ?? -1
    if (pair && eq > 0 && pair.slice(0, eq) === name) return pair.slice(eq + 1)
  }
  return null
}

async function sessionUserId(sessionCookie: string): Promise<number | null> {
  const res = await fetch(`${TEST_BASE_URL}/api/_auth/session`, { headers: { cookie: `${SESSION_COOKIE}=${sessionCookie}` } })
  const body = await res.json() as { user?: { id?: number } }
  return body.user?.id ?? null
}

/** Cookie header of a logged-in test client (for the browser-like legs). */
async function cookieOf(userId: number): Promise<string> {
  const client = await loggedInClient(userId)
  return client.cookieHeader()
}

interface Finished {
  location: string
  session: string | null
}

async function oidcSignIn(connectionId: string, idpUser: { sub: string, claims: Record<string, unknown> }, opts: { test?: boolean, cookie?: string } = {}): Promise<Finished> {
  const start = await fetch(`${TEST_BASE_URL}/auth/sso/${connectionId}${opts.test ? '?test=1' : ''}`, {
    redirect: 'manual',
    headers: opts.cookie ? { cookie: opts.cookie } : {}
  })
  expect(start.status, await start.clone().text()).toBe(302)
  const authorize = start.headers.get('location')!
  const flow = cookieValue(start, FLOW_COOKIE)
  if (!flow) return { location: authorize, session: null } // refused before the IdP
  const idp = await fetch(authorize, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: idpUser.sub, claims: JSON.stringify(idpUser.claims) }) })
  expect(idp.status).toBe(302)
  const back = await fetch(idp.headers.get('location')!, { redirect: 'manual', headers: { cookie: `${FLOW_COOKIE}=${flow}` } })
  expect(back.status).toBe(302)
  return { location: back.headers.get('location')!, session: cookieValue(back, SESSION_COOKIE) }
}

async function samlStart(connectionId: string, opts: { test?: boolean, cookie?: string } = {}): Promise<{ requestId: string, flow: string }> {
  const start = await fetch(`${TEST_BASE_URL}/auth/sso/${connectionId}${opts.test ? '?test=1' : ''}`, { redirect: 'manual', headers: opts.cookie ? { cookie: opts.cookie } : {} })
  expect(start.status).toBe(302)
  return { requestId: await authnRequestId(start.headers.get('location')!), flow: cookieValue(start, FLOW_COOKIE)! }
}

async function samlPost(connectionId: string, flow: string | null, response: string): Promise<Finished> {
  const res = await fetch(`${TEST_BASE_URL}/auth/sso/${connectionId}/acs`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(flow ? { cookie: `${FLOW_COOKIE}=${flow}` } : {}) },
    body: new URLSearchParams({ SAMLResponse: response })
  })
  expect(res.status).toBe(302)
  return { location: res.headers.get('location')!, session: cookieValue(res, SESSION_COOKIE) }
}

async function verifyDomain(wsId: string, domain: string): Promise<void> {
  await testDb().query(`INSERT INTO sso_domains (workspace_id, domain, verification_token, verified_at) VALUES ($1, $2, 't', now())`, [wsId, domain])
}

async function connectionRow(wsId: string) {
  return (await testDb().query<{ id: string, status: string, oidc_client_secret: string | null }>('SELECT id, status, oidc_client_secret FROM sso_connections WHERE workspace_id = $1', [wsId])).rows[0]
}

async function setupOidc(adminId: number, wsId: string): Promise<{ id: string, issuer: string }> {
  const issuer = `${ssoMockIdpBase()}/ws-${randomBytes(4).toString('hex')}`
  const client = await loggedInClient(adminId)
  const res = await client.put(`/api/workspaces/${wsId}/sso`, { protocol: 'oidc', oidcIssuer: issuer, oidcClientId: 'markoto', oidcClientSecret: 'idp-secret' })
  expect(res.status, await res.clone().text()).toBe(200)
  const view = await res.json() as { connection: { id: string, status: string, hasClientSecret: boolean } }
  expect(view.connection).toMatchObject({ status: 'draft', hasClientSecret: true })
  expect(JSON.stringify(view)).not.toContain('idp-secret')
  return { id: view.connection.id, issuer }
}

async function activateOidc(adminId: number, wsId: string, adminEmail = 'admin@acme.test'): Promise<string> {
  const { id } = await setupOidc(adminId, wsId)
  const done = await oidcSignIn(id, { sub: `admin-${adminId}`, claims: { email: adminEmail, email_verified: true, name: 'Admin' } }, { test: true, cookie: await cookieOf(adminId) })
  expect(done.location).toBe(`/w/${wsId}?tab=sso&test=activated`)
  expect((await connectionRow(wsId))?.status).toBe('active')
  return id
}

describe('SSO settings', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('admins only; the client secret is stored encrypted and never returned', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const editor = await createUser()
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    expect((await (await loggedInClient(editor.id)).get(`/api/workspaces/${ws.workspaceId}/sso`)).status).toBe(403)
    expect((await (await loggedInClient((await createUser()).id)).get(`/api/workspaces/${ws.workspaceId}/sso`)).status).toBe(404)

    await setupOidc(admin.id, ws.workspaceId)
    const row = await connectionRow(ws.workspaceId)
    expect(row?.oidc_client_secret).toBeTruthy()
    expect(row?.oidc_client_secret).not.toContain('idp-secret')
  })

  it('refuses IdP URLs the server must not call (SSRF) and junk certificates', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    for (const issuer of ['http://127.0.0.1:4130/x', 'http://169.254.169.254/latest', 'https://postgres-test/x', 'https://litellm/x']) {
      const res = await client.put(`/api/workspaces/${ws.workspaceId}/sso`, { protocol: 'oidc', oidcIssuer: issuer, oidcClientId: 'a', oidcClientSecret: 'b' })
      expect(res.status, issuer).toBe(400)
      expect((await res.json() as { data?: { field?: string } }).data?.field).toBe('oidcIssuer')
    }
    const bad = await client.put(`/api/workspaces/${ws.workspaceId}/sso`, { protocol: 'saml', samlIdpEntityId: 'x', samlSsoUrl: 'https://idp.example/sso', samlIdpCert: 'not a certificate' })
    expect(bad.status).toBe(400)
  })

  it('on markoto.app (free plan, no private IdPs) SSO is not available', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id, undefined, TEST_BILLING_OFF_BASE_URL)
    const res = await client.put(`/api/workspaces/${ws.workspaceId}/sso`, { protocol: 'oidc', oidcIssuer: `${ssoMockIdpBase()}/x`, oidcClientId: 'a', oidcClientSecret: 'b' })
    expect(res.status).toBe(409)
    expect((await res.json() as { data?: { code?: string } }).data?.code).toBe('plan/feature-unavailable')
    expect((await (await client.get(`/api/workspaces/${ws.workspaceId}/sso`)).json() as { available: boolean }).available).toBe(false)
  })

  it('domains: consumer mail refused, verified by one workspace only', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    expect((await client.post(`/api/workspaces/${ws.workspaceId}/sso/domains`, { domain: 'gmail.com' })).status).toBe(400)
    const added = await client.post(`/api/workspaces/${ws.workspaceId}/sso/domains`, { domain: 'Acme.test' })
    expect(added.status).toBe(200)
    const d = await added.json() as { id: number, domain: string, verified: boolean, txtValue: string }
    expect(d).toMatchObject({ domain: 'acme.test', verified: false })
    expect(d.txtValue).toMatch(/^markoto-verification=/)
    // No TXT record in the test DNS → not verified.
    const verify = await client.post(`/api/workspaces/${ws.workspaceId}/sso/domains/${d.id}/verify`, {})
    expect(verify.status).toBe(422)

    const other = await createWorkspace(admin.id)
    await verifyDomain(other.workspaceId, 'taken.test')
    await testDb().query(`INSERT INTO sso_domains (workspace_id, domain, verification_token) VALUES ($1, 'taken.test', 't')`, [ws.workspaceId])
    await expect(testDb().query(`UPDATE sso_domains SET verified_at = now() WHERE workspace_id = $1 AND domain = 'taken.test'`, [ws.workspaceId])).rejects.toThrow()
  })
})

describe('SSO with OpenID Connect', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('a draft connection only signs in admins testing it; the test activates it', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const { id } = await setupOidc(admin.id, ws.workspaceId)
    const notYet = await fetch(`${TEST_BASE_URL}/auth/sso/${id}`, { redirect: 'manual' })
    expect(notYet.headers.get('location')).toContain('/auth/sso-error?code=sso%2Fnot-active')

    const editor = await createUser()
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const editorTest = await fetch(`${TEST_BASE_URL}/auth/sso/${id}?test=1`, { redirect: 'manual', headers: { cookie: await cookieOf(editor.id) } })
    expect(editorTest.status).toBe(403)

    const done = await oidcSignIn(id, { sub: 'admin-sub', claims: { email: 'whoever@elsewhere.test', email_verified: true, name: 'A' } }, { test: true, cookie: await cookieOf(admin.id) })
    expect(done.location).toBe(`/w/${ws.workspaceId}?tab=sso&test=activated`)
    expect(await sessionUserId(done.session!)).toBe(admin.id)
    const identity = (await testDb().query('SELECT user_id, subject FROM user_identities')).rows
    expect(identity).toEqual([{ user_id: admin.id, subject: 'admin-sub' }])
  })

  it('once active, members need a sign-in through the IdP — on every access path', async () => {
    const admin = await createUser({ email: 'admin@acme.test' })
    const ws = await createWorkspace(admin.id)
    const member = await createUser({ email: 'ben@acme.test' })
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    const connectionId = await activateOidc(admin.id, ws.workspaceId)

    const asMember = await loggedInClient(member.id)
    const wsRes = await asMember.get(`/api/workspaces/${ws.workspaceId}`)
    expect(wsRes.status).toBe(403)
    expect(await wsRes.json()).toMatchObject({ data: { code: 'sso/required', loginUrl: `/auth/sso/${connectionId}?returnTo=${encodeURIComponent(`/w/${ws.workspaceId}`)}` } })
    const token = await (await asMember.get(`/api/docs/${doc.docId}/token`)).json() as { token: string | null, forbidden: boolean, ssoLoginUrl: string | null }
    expect(token).toMatchObject({ token: null, forbidden: true })
    expect(token.ssoLoginUrl).toContain(`/auth/sso/${connectionId}`)
    expect((await asMember.get(`/api/workspaces/${ws.workspaceId}/knowledge`)).status).not.toBe(200)
    // Outsiders still learn nothing.
    expect((await (await loggedInClient((await createUser()).id)).get(`/api/workspaces/${ws.workspaceId}`)).status).toBe(404)

    // Without a verified domain the IdP can't speak for ben@acme.test.
    const refused = await oidcSignIn(connectionId, { sub: 'ben-sub', claims: { email: 'ben@acme.test', email_verified: true, name: 'Ben' } })
    expect(refused.location).toContain('code=sso%2Fnot-provisioned')

    // With the domain verified, the sign-in links to Ben's account.
    await verifyDomain(ws.workspaceId, 'acme.test')
    const ok = await oidcSignIn(connectionId, { sub: 'ben-sub', claims: { email: 'ben@acme.test', email_verified: true, name: 'Ben' } })
    expect(ok.location).toBe(`/w/${ws.workspaceId}`)
    expect(await sessionUserId(ok.session!)).toBe(member.id)
    expect((await asMember.get(`/api/workspaces/${ws.workspaceId}`)).status).toBe(200)
    expect((await (await asMember.get(`/api/docs/${doc.docId}/token`)).json() as { token: string | null }).token).toBeTruthy()

    // "Log out everywhere" voids the grant.
    await testDb().query('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1', [member.id])
    const fresh = await loggedInClient(member.id)
    expect((await fresh.get(`/api/workspaces/${ws.workspaceId}`)).status).toBe(403)
  })

  it('a new address in a verified domain joins as the default role (JIT); an expired grant locks out again', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const connectionId = await activateOidc(admin.id, ws.workspaceId)
    await verifyDomain(ws.workspaceId, 'acme.test')
    const done = await oidcSignIn(connectionId, { sub: 'cleo-sub', claims: { email: 'Cleo@Acme.test', email_verified: true, name: 'Cleo' } })
    expect(done.location).toBe(`/w/${ws.workspaceId}`)
    const cleo = (await testDb().query<{ id: number, email: string }>(`SELECT id, email FROM users WHERE email = 'cleo@acme.test'`)).rows[0]!
    expect(await sessionUserId(done.session!)).toBe(cleo.id)
    expect((await testDb().query('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws.workspaceId, cleo.id])).rows).toEqual([{ role: 'editor' }])
    const audit = (await testDb().query(`SELECT action FROM audit_log WHERE scope_id = $1 AND action LIKE 'sso.%' ORDER BY id`, [ws.workspaceId])).rows.map(r => r.action)
    expect(audit).toEqual(expect.arrayContaining(['sso.connection_saved', 'sso.connection_activated', 'sso.member_joined', 'sso.identity_linked', 'sso.sign_in']))

    await testDb().query(`UPDATE sso_grants SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [cleo.id])
    expect((await (await loggedInClient(cleo.id)).get(`/api/workspaces/${ws.workspaceId}`)).status).toBe(403)
  })

  it('admins keep the SSO settings without a grant (break-glass) and can switch enforcement off', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await activateOidc(admin.id, ws.workspaceId)
    await testDb().query('DELETE FROM sso_grants')
    const client = await loggedInClient(admin.id)
    expect((await client.get(`/api/workspaces/${ws.workspaceId}`)).status).toBe(403)
    expect((await client.get(`/api/workspaces/${ws.workspaceId}/sso`)).status).toBe(200)
    expect((await client.delete(`/api/workspaces/${ws.workspaceId}/sso`)).status).toBe(200)
    expect((await client.get(`/api/workspaces/${ws.workspaceId}`)).status).toBe(200)
  })

  it('changing the IdP settings returns the connection to draft (no lock-out by typo)', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await activateOidc(admin.id, ws.workspaceId)
    const res = await (await loggedInClient(admin.id)).put(`/api/workspaces/${ws.workspaceId}/sso`, { protocol: 'oidc', oidcIssuer: `${ssoMockIdpBase()}/other`, oidcClientId: 'markoto' })
    expect(res.status).toBe(200)
    expect((await connectionRow(ws.workspaceId))?.status).toBe('draft')
  })

  it('a callback without this browser\'s flow cookie is refused', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const connectionId = await activateOidc(admin.id, ws.workspaceId)
    const start = await fetch(`${TEST_BASE_URL}/auth/sso/${connectionId}`, { redirect: 'manual' })
    const idp = await fetch(start.headers.get('location')!, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: 'x', claims: '{}' }) })
    const back = await fetch(idp.headers.get('location')!, { redirect: 'manual' })
    expect(back.headers.get('location')).toContain('code=sso%2Ffailed')
    expect(cookieValue(back, SESSION_COOKIE)).toBeNull()
  })
})

describe('SSO with SAML', () => {
  let idp: IdpKeyPair
  let otherIdp: IdpKeyPair
  const IDP_ENTITY = 'https://idp.acme.test/saml'

  beforeAll(() => {
    idp = makeIdpKeyPair()
    otherIdp = makeIdpKeyPair('someone-else')
  })
  beforeEach(async () => {
    await resetDb()
  })

  async function setupSaml(adminId: number, wsId: string): Promise<{ id: string, acsUrl: string, entityId: string }> {
    const res = await (await loggedInClient(adminId)).put(`/api/workspaces/${wsId}/sso`, { protocol: 'saml', samlIdpEntityId: IDP_ENTITY, samlSsoUrl: 'https://idp.acme.test/sso', samlIdpCert: idp.cert })
    expect(res.status, await res.clone().text()).toBe(200)
    const view = await res.json() as { connection: { id: string, samlCertificate: { subject: string }, sp: { acsUrl: string, entityId: string } } }
    expect(view.connection.samlCertificate.subject).toContain('markoto-test-idp')
    return { id: view.connection.id, acsUrl: view.connection.sp.acsUrl, entityId: view.connection.sp.entityId }
  }

  async function activateSaml(adminId: number, wsId: string) {
    const sp = await setupSaml(adminId, wsId)
    const { requestId, flow } = await samlStart(sp.id, { test: true, cookie: await cookieOf(adminId) })
    const done = await samlPost(sp.id, flow, samlResponse({ idp, issuer: IDP_ENTITY, inResponseTo: requestId, acsUrl: sp.acsUrl, audience: sp.entityId, nameId: `admin-${adminId}` }))
    expect(done.location).toBe(`/w/${wsId}?tab=sso&test=activated`)
    return sp
  }

  it('serves SP metadata, and a correct signed response activates + signs in', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const sp = await activateSaml(admin.id, ws.workspaceId)
    const meta = await fetch(`${TEST_BASE_URL}/auth/sso/${sp.id}/metadata`)
    expect(meta.status).toBe(200)
    const xml = await meta.text()
    expect(xml).toContain(sp.entityId)
    expect(xml).toContain(sp.acsUrl)
  })

  it('refuses forged, misdirected, expired, unsolicited and replayed responses', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const sp = await activateSaml(admin.id, ws.workspaceId)
    await verifyDomain(ws.workspaceId, 'acme.test')
    const base = { idp, issuer: IDP_ENTITY, acsUrl: sp.acsUrl, audience: sp.entityId, nameId: 'dana-sub', email: 'dana@acme.test' }

    const cases: Array<[string, (requestId: string) => string]> = [
      ['signed by another key', rid => samlResponse({ ...base, idp: otherIdp, inResponseTo: rid })],
      ['unsigned', rid => samlResponse({ ...base, inResponseTo: rid, sign: false })],
      ['wrong audience', rid => samlResponse({ ...base, inResponseTo: rid, audience: 'https://evil.example/sp' })],
      ['wrong issuer', rid => samlResponse({ ...base, inResponseTo: rid, issuer: 'https://evil.example/idp' })],
      ['expired', rid => samlResponse({ ...base, inResponseTo: rid, notBefore: new Date(Date.now() - 3_600_000), notOnOrAfter: new Date(Date.now() - 600_000) })],
      ['answers another request', () => samlResponse({ ...base, inResponseTo: '_not-this-browsers-request' })],
      ['unsolicited (IdP-initiated)', () => samlResponse({ ...base, inResponseTo: null })]
    ]
    for (const [label, make] of cases) {
      const { requestId, flow } = await samlStart(sp.id)
      const done = await samlPost(sp.id, flow, make(requestId))
      expect(done.location, label).toContain('code=sso%2Ffailed')
      expect(done.session, label).toBeNull()
    }

    // A good response works once; the same response again does not.
    const { requestId, flow } = await samlStart(sp.id)
    const good = samlResponse({ ...base, inResponseTo: requestId })
    const first = await samlPost(sp.id, flow, good)
    expect(first.location).toBe(`/w/${ws.workspaceId}`)
    const replay = await samlPost(sp.id, flow, good)
    expect(replay.location).toContain('code=sso%2Ffailed')
    // Another browser's flow can't carry it either.
    const second = await samlStart(sp.id)
    expect((await samlPost(sp.id, second.flow, good)).location).toContain('code=sso%2Ffailed')
  })

  it('without a flow cookie (another browser) the response is refused', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const sp = await activateSaml(admin.id, ws.workspaceId)
    const { requestId } = await samlStart(sp.id)
    const done = await samlPost(sp.id, null, samlResponse({ idp, issuer: IDP_ENTITY, inResponseTo: requestId, acsUrl: sp.acsUrl, audience: sp.entityId, nameId: 'x' }))
    expect(done.location).toContain('code=sso%2Ffailed')
  })
})

describe('SCIM provisioning (/scim/v2/Users)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  async function scimSetup() {
    const admin = await createUser({ email: 'admin@acme.test' })
    const ws = await createWorkspace(admin.id)
    const connectionId = await activateOidc(admin.id, ws.workspaceId)
    await verifyDomain(ws.workspaceId, 'acme.test')
    const tokenRes = await (await loggedInClient(admin.id)).post(`/api/workspaces/${ws.workspaceId}/sso/scim-token`, {})
    expect(tokenRes.status).toBe(200)
    const { token, baseUrl } = await tokenRes.json() as { token: string, baseUrl: string }
    expect(baseUrl).toBe(`${TEST_BASE_URL}/scim/v2`)
    const scim = (path: string, init: { method?: string, body?: unknown, token?: string } = {}) => fetch(`${TEST_BASE_URL}/scim/v2${path}`, {
      method: init.method ?? 'GET',
      headers: { 'authorization': `Bearer ${init.token ?? token}`, 'content-type': 'application/scim+json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    })
    return { admin, ws, connectionId, scim }
  }

  const member = (wsId: string, userId: number) => testDb().query('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [wsId, userId]).then(r => r.rows[0]?.role ?? null)

  it('refuses requests without the token, with SCIM error bodies', async () => {
    const { scim } = await scimSetup()
    const res = await scim('/Users', { token: 'mkscim_wrong-token-wrong-token-wrong' })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401' })
  })

  it('creates a member, finds them by filter, deactivates (Entra + Okta style), reactivates and deletes', async () => {
    const { ws, scim } = await scimSetup()
    const notOurs = await scim('/Users', { method: 'POST', body: { userName: 'eve@elsewhere.test', active: true } })
    expect(notOurs.status).toBe(400)

    const created = await scim('/Users', { method: 'POST', body: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'Finn@Acme.test', externalId: 'ext-finn', name: { givenName: 'Finn', familyName: 'Ito' }, active: true } })
    expect(created.status).toBe(201)
    const user = await created.json() as { id: string, userName: string, active: boolean, externalId: string }
    expect(user).toMatchObject({ userName: 'finn@acme.test', active: true, externalId: 'ext-finn' })
    const finn = (await testDb().query<{ id: number, name: string }>(`SELECT id, name FROM users WHERE email = 'finn@acme.test'`)).rows[0]!
    expect(finn.name).toBe('Finn Ito')
    expect(await member(ws.workspaceId, finn.id)).toBe('editor')
    expect((await scim('/Users', { method: 'POST', body: { userName: 'finn@acme.test' } })).status).toBe(409)

    const found = await (await scim(`/Users?filter=${encodeURIComponent('userName eq "FINN@acme.test"')}`)).json() as { totalResults: number, Resources: Array<{ id: string }> }
    expect(found.totalResults).toBe(1)
    expect(found.Resources[0]!.id).toBe(user.id)
    expect((await (await scim(`/Users?filter=${encodeURIComponent('externalId eq "ext-finn"')}`)).json() as { totalResults: number }).totalResults).toBe(1)

    // Entra ID: path + string boolean.
    const off = await scim(`/Users/${user.id}`, { method: 'PATCH', body: { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] } })
    expect(off.status).toBe(200)
    expect((await off.json() as { active: boolean }).active).toBe(false)
    expect(await member(ws.workspaceId, finn.id)).toBeNull()
    // Okta: no path, value object.
    const on = await scim(`/Users/${user.id}`, { method: 'PATCH', body: { Operations: [{ op: 'replace', value: { active: true } }] } })
    expect((await on.json() as { active: boolean }).active).toBe(true)
    expect(await member(ws.workspaceId, finn.id)).toBe('editor')

    expect((await scim(`/Users/${user.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await member(ws.workspaceId, finn.id)).toBeNull()
    expect((await scim(`/Users/${user.id}`)).status).toBe(404)
    // The account itself stays.
    expect((await testDb().query('SELECT id FROM users WHERE id = $1', [finn.id])).rows).toHaveLength(1)
  })

  it('a deactivated user can\'t sign in; the first sign-in of a provisioned user takes over the placeholder', async () => {
    const { ws, connectionId, scim } = await scimSetup()
    const created = await (await scim('/Users', { method: 'POST', body: { userName: 'gia@acme.test', externalId: 'ext-gia' } })).json() as { id: string }
    const signedIn = await oidcSignIn(connectionId, { sub: 'gia-real-sub', claims: { email: 'gia@acme.test', email_verified: true, name: 'Gia' } })
    expect(signedIn.location).toBe(`/w/${ws.workspaceId}`)
    expect((await testDb().query('SELECT subject, scim_external_id FROM user_identities WHERE id = $1', [Number(created.id)])).rows).toEqual([{ subject: 'gia-real-sub', scim_external_id: 'ext-gia' }])

    await scim(`/Users/${created.id}`, { method: 'PATCH', body: { Operations: [{ op: 'replace', path: 'active', value: false }] } })
    const refused = await oidcSignIn(connectionId, { sub: 'gia-real-sub', claims: { email: 'gia@acme.test', email_verified: true, name: 'Gia' } })
    expect(refused.location).toContain('code=sso%2Fdeactivated')
  })

  it('never removes the last admin', async () => {
    const { admin, scim } = await scimSetup()
    const list = await (await scim(`/Users?filter=${encodeURIComponent('userName eq "admin@acme.test"')}`)).json() as { Resources: Array<{ id: string }> }
    const res = await scim(`/Users/${list.Resources[0]!.id}`, { method: 'PATCH', body: { Operations: [{ op: 'replace', path: 'active', value: false }] } })
    expect(res.status).toBe(409)
    expect((await testDb().query('SELECT role FROM workspace_members WHERE user_id = $1', [admin.id])).rows).toEqual([{ role: 'admin' }])
  })
})

describe('Sign in with your organisation (discover) + the workspace\'s SSO state', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('finds the active connection of the workspace that verified the domain, nothing else', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const discover = (email: string, returnTo?: string) => fetch(`${TEST_BASE_URL}/api/auth/sso/discover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, returnTo })
    })
    expect((await discover('ada@acme.test')).status).toBe(404)
    const connectionId = await activateOidc(admin.id, ws.workspaceId)
    expect((await discover('ada@acme.test')).status).toBe(404) // domain not verified
    await verifyDomain(ws.workspaceId, 'acme.test')
    const ok = await discover('Ada@ACME.test', '/d/abc')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ loginUrl: `/auth/sso/${connectionId}?returnTo=${encodeURIComponent('/d/abc')}` })
    // An off-site returnTo is dropped.
    expect(await (await discover('ada@acme.test', '//evil.example')).json()).toEqual({ loginUrl: `/auth/sso/${connectionId}` })
  })

  it('admins see whether SSO is available and on; members don\'t', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const editor = await createUser()
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const adminView = await (await (await loggedInClient(admin.id)).get(`/api/workspaces/${ws.workspaceId}`)).json() as { workspace: { sso: unknown } }
    expect(adminView.workspace.sso).toEqual({ available: true, status: 'none' })
    const editorView = await (await (await loggedInClient(editor.id)).get(`/api/workspaces/${ws.workspaceId}`)).json() as { workspace: { sso: unknown } }
    expect(editorView.workspace.sso).toBeNull()
  })
})

// Ownership of a workspace document is not a way around enforcement:
// in a workspace that enforces SSO, a member's OWN docs need the same
// current grant (and membership) as everyone else's. Outside such
// workspaces ownership keeps working as before.
describe('SSO enforcement covers the documents a member owns', () => {
  beforeEach(async () => {
    await resetDb()
  })

  const FILE = 'abcdefghijkl.png'

  /** The user a finished sign-in signed in as (fails the test otherwise). */
  async function signedInUser(done: Finished): Promise<number> {
    const id = done.session === null ? null : await sessionUserId(done.session)
    if (id === null) throw new Error(`sign-in did not create a session (landed on ${done.location})`)
    return id
  }

  /** What a member can do with a doc they own; true = allowed. */
  async function ownerAccess(userId: number, docId: string, wsId: string) {
    const client = await loggedInClient(userId)
    const token = await (await client.get(`/api/docs/${docId}/token`)).json() as { token: string | null, forbidden: boolean, ssoLoginUrl?: string | null }
    const meta = await client.get(`/api/docs/${docId}/meta`)
    const metaBody = await meta.json() as { forbidden?: boolean, title?: string }
    const members = await (await client.get(`/api/docs/${docId}/members`)).json() as { members: unknown[] }
    return {
      token: token.token !== null,
      ssoLoginUrl: token.ssoLoginUrl ?? null,
      metaGet: metaBody.forbidden !== true && metaBody.title !== undefined,
      metaPut: (await client.put(`/api/docs/${docId}/meta`, { title: 'Renamed' })).status === 200,
      files: (await client.get(`/api/files/${docId}/${FILE}`)).status === 302,
      fileToken: (await client.get(`/api/docs/${docId}/file-token`)).status === 200,
      activity: (await client.get(`/api/docs/${docId}/activity`)).status === 200,
      roster: members.members.length > 0,
      duplicate: (await client.post(`/api/docs/${docId}/duplicate`, {})).status === 200,
      // Same workspace → no-op success when allowed, never a real move.
      move: (await client.patch(`/api/docs/${docId}/workspace`, { workspaceId: wsId })).status === 200,
      setPassword: (await client.post(`/api/docs/${docId}/password`, { action: 'set', password: 'long-enough-pw' })).status
    }
  }

  async function memberWithOwnDoc() {
    const admin = await createUser({ email: 'admin@acme.test' })
    const ws = await createWorkspace(admin.id)
    const member = await createUser({ email: 'ben@acme.test' })
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    const doc = await createDoc({ ownerId: member.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    return { admin, ws, member, doc }
  }

  it('without a current grant the owner gets nothing on their private doc; with one, everything', async () => {
    const { admin, ws, member, doc } = await memberWithOwnDoc()
    const connectionId = await activateOidc(admin.id, ws.workspaceId)

    const blocked = await ownerAccess(member.id, doc.docId, ws.workspaceId)
    expect(blocked).toMatchObject({ token: false, metaGet: false, metaPut: false, files: false, fileToken: false, activity: false, roster: false, duplicate: false, move: false })
    expect(blocked.setPassword).toBe(403)
    expect(blocked.ssoLoginUrl).toContain(`/auth/sso/${connectionId}`)
    // Nor can they delete it or get it out of the workspace.
    const asMember = await loggedInClient(member.id)
    expect((await asMember.patch(`/api/docs/${doc.docId}/workspace`, { workspaceId: null })).status).toBe(403)
    expect((await asMember.delete(`/api/docs/${doc.docId}`)).status).toBe(403)
    expect((await testDb().query('SELECT workspace_id FROM documents WHERE doc_id = $1', [doc.docId])).rows).toEqual([{ workspace_id: ws.workspaceId }])

    // Signed in through the workspace's IdP: ownership counts again.
    await verifyDomain(ws.workspaceId, 'acme.test')
    const signedIn = await oidcSignIn(connectionId, { sub: 'ben-sub', claims: { email: 'ben@acme.test', email_verified: true, name: 'Ben' } })
    expect(await signedInUser(signedIn)).toBe(member.id)
    const allowed = await ownerAccess(member.id, doc.docId, ws.workspaceId)
    expect(allowed).toMatchObject({ token: true, metaGet: true, metaPut: true, files: true, fileToken: true, activity: true, roster: true, duplicate: true, move: true })
    expect(allowed.setPassword).toBe(200)

    // An expired grant locks the owner out of their own doc again.
    await testDb().query(`UPDATE sso_grants SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [member.id])
    const expired = await ownerAccess(member.id, doc.docId, ws.workspaceId)
    expect(expired).toMatchObject({ token: false, metaPut: false, files: false })
  })

  it('a public-link doc stays public for its owner too — no more than any outsider gets', async () => {
    const { admin, ws, member } = await memberWithOwnDoc()
    const openView = await createDoc({ ownerId: member.id, workspaceId: ws.workspaceId, accessMode: 'open-view' })
    await activateOidc(admin.id, ws.workspaceId)
    const client = await loggedInClient(member.id)
    const token = await (await client.get(`/api/docs/${openView.docId}/token`)).json() as { token: string | null, readOnly: boolean, canDelete: boolean }
    expect(token).toMatchObject({ readOnly: true, canDelete: false })
    expect(token.token).toBeTruthy()
    expect((await client.put(`/api/docs/${openView.docId}/meta`, { title: 'x' })).status).toBe(403)
  })

  it('SCIM deactivation and deletion take the owner out of their own workspace docs at once', async () => {
    const admin = await createUser({ email: 'admin@acme.test' })
    const ws = await createWorkspace(admin.id)
    const connectionId = await activateOidc(admin.id, ws.workspaceId)
    await verifyDomain(ws.workspaceId, 'acme.test')
    const tokenRes = await (await loggedInClient(admin.id)).post(`/api/workspaces/${ws.workspaceId}/sso/scim-token`, {})
    const { token: scimToken } = await tokenRes.json() as { token: string }
    const scim = (path: string, method: string, body?: unknown) => fetch(`${TEST_BASE_URL}/scim/v2${path}`, {
      method,
      headers: { 'authorization': `Bearer ${scimToken}`, 'content-type': 'application/scim+json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })

    const created = await (await scim('/Users', 'POST', { userName: 'hana@acme.test', externalId: 'ext-hana', active: true })).json() as { id: string }
    const signIn = () => oidcSignIn(connectionId, { sub: 'hana-sub', claims: { email: 'hana@acme.test', email_verified: true, name: 'Hana' } })
    const first = await signIn()
    const hanaId = await signedInUser(first)
    // The account was created by the sign-in: pass the onboarding gate as
    // a returning user would have (the test server has legal surfaces on).
    await testDb().query(
      `UPDATE users SET age_confirmed_at = NOW(), privacy_version_accepted = $2, privacy_version_accepted_locale = 'en',
         tos_version_accepted = $3, tos_version_accepted_locale = 'en' WHERE id = $1`,
      [hanaId, PRIVACY_VERSION, TOS_VERSION]
    )
    const doc = await createDoc({ ownerId: hanaId, workspaceId: ws.workspaceId, accessMode: 'private' })
    expect(await ownerAccess(hanaId, doc.docId, ws.workspaceId)).toMatchObject({ token: true, metaPut: true, files: true })

    // Deactivated: membership + grant gone → no access to the doc she owns.
    expect((await scim(`/Users/${created.id}`, 'PATCH', { Operations: [{ op: 'replace', path: 'active', value: false }] })).status).toBe(200)
    const deactivated = await ownerAccess(hanaId, doc.docId, ws.workspaceId)
    expect(deactivated).toMatchObject({ token: false, metaGet: false, metaPut: false, files: false, fileToken: false, activity: false, roster: false, duplicate: false })
    expect(deactivated.ssoLoginUrl).toBeNull() // no longer a member: nothing to sign in to
    expect((await (await loggedInClient(hanaId)).delete(`/api/docs/${doc.docId}`)).status).toBe(403)

    // Reactivated + signed in again: back in.
    await scim(`/Users/${created.id}`, 'PATCH', { Operations: [{ op: 'replace', value: { active: true } }] })
    await signIn()
    expect(await ownerAccess(hanaId, doc.docId, ws.workspaceId)).toMatchObject({ token: true, files: true })

    // Deleted via SCIM: out of the workspace, and out of her docs in it.
    expect((await scim(`/Users/${created.id}`, 'DELETE')).status).toBe(204)
    expect(await ownerAccess(hanaId, doc.docId, ws.workspaceId)).toMatchObject({ token: false, metaPut: false, files: false, activity: false })
  })

  it('outside SSO-enforcing workspaces ownership works as before', async () => {
    // A workspace whose connection is still a draft enforces nothing.
    const { admin, ws, member, doc } = await memberWithOwnDoc()
    await setupOidc(admin.id, ws.workspaceId)
    expect(await ownerAccess(member.id, doc.docId, ws.workspaceId)).toMatchObject({ token: true, metaPut: true, files: true, activity: true })

    // A workspace without SSO: an owner who is no longer a member keeps
    // their doc.
    const plainAdmin = await createUser()
    const plain = await createWorkspace(plainAdmin.id)
    const owner = await createUser()
    await setMemberRole(plain.workspaceId, owner.id, 'editor')
    const own = await createDoc({ ownerId: owner.id, workspaceId: plain.workspaceId, accessMode: 'private' })
    await testDb().query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [plain.workspaceId, owner.id])
    const access = await ownerAccess(owner.id, own.docId, plain.workspaceId)
    expect(access).toMatchObject({ token: true, metaGet: true, metaPut: true, files: true, fileToken: true, activity: true, roster: true })
    // A standalone doc is untouched by any of this.
    const standalone = await createDoc({ ownerId: member.id, accessMode: 'private' })
    const client = await loggedInClient(member.id)
    expect((await (await client.get(`/api/docs/${standalone.docId}/token`)).json() as { token: string | null }).token).toBeTruthy()
  })
})
