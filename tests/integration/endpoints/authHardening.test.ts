import { describe, it, expect, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { TEST_BASE_URL, TEST_JWT_SECRET } from '../setup/env'
import { PRIVACY_VERSION, TOS_VERSION } from '../../../shared/legal/versions'

// Access / auth hardening over real HTTP:
//   - document password only works while the doc IS password-protected,
//     and never upgrades a workspace viewer to edit;
//   - workspace viewers stay read-only on open-edit docs on every
//     server-side write path;
//   - signed-in users who haven't accepted the current terms can't change
//     state (hosted shape: legal surfaces are on in the test server);
//   - state-changing requests from a foreign Origin are refused;
//   - the consent endpoint writes at most one row per purpose.

async function passwordHashOf(docId: string): Promise<string | null> {
  const r = await testDb().query<{ password_hash: string | null }>(
    'SELECT password_hash FROM documents WHERE doc_id = $1',
    [docId]
  )
  return r.rows[0]?.password_hash ?? null
}

async function setPassword(ownerId: number, docId: string, password: string): Promise<void> {
  const client = await loggedInClient(ownerId)
  const res = await client.post(`/api/docs/${docId}/password`, { action: 'set', password })
  expect(res.status).toBe(200)
}

describe('document password vs access mode', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('a doc switched from password-protected to private no longer accepts the old password', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    await setPassword(owner.id, doc.docId, 'correct-horse')

    const ownerClient = await loggedInClient(owner.id)
    const meta = await ownerClient.put(`/api/docs/${doc.docId}/meta`, { accessMode: 'private' })
    expect(meta.status).toBe(200)
    // Leaving password mode drops the stored hash.
    expect(await passwordHashOf(doc.docId)).toBeNull()

    const verify = await anonClient().post(`/api/docs/${doc.docId}/password`, { action: 'verify', password: 'correct-horse' })
    expect(verify.status).toBe(400)
  })

  it('a stale hash left on a non-password doc never mints a token', async () => {
    // Rows written before the hash was cleared on mode change still carry
    // one; verify must refuse outside password mode regardless.
    const owner = await createUser()
    const source = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    await setPassword(owner.id, source.docId, 'correct-horse')
    const legacy = await createDoc({
      ownerId: owner.id,
      accessMode: 'private',
      passwordHash: await passwordHashOf(source.docId)
    })

    const verify = await anonClient().post(`/api/docs/${legacy.docId}/password`, { action: 'verify', password: 'correct-horse' })
    expect(verify.status).toBe(400)
    const body = await verify.json() as { token?: string }
    expect(body.token).toBeUndefined()
  })

  it('a workspace viewer who knows the password stays read-only', async () => {
    const owner = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    await setPassword(owner.id, doc.docId, 'correct-horse')

    const viewerClient = await loggedInClient(viewer.id)
    const res = await viewerClient.post(`/api/docs/${doc.docId}/password`, { action: 'verify', password: 'correct-horse' })
    expect(res.status).toBe(200)
    const body = await res.json() as { token: string, readOnly: boolean }
    expect(body.readOnly).toBe(true)
    const claims = jwt.verify(body.token, TEST_JWT_SECRET) as Record<string, unknown>
    expect(claims.readOnly).toBe(true)
  })

  it('an outsider who knows the password gets edit access', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    await setPassword(owner.id, doc.docId, 'correct-horse')
    const res = await anonClient().post(`/api/docs/${doc.docId}/password`, { action: 'verify', password: 'correct-horse' })
    expect(res.status).toBe(200)
    expect((await res.json() as { readOnly: boolean }).readOnly).toBe(false)
  })

  it('duplicating a non-password doc does not carry a stale hash over', async () => {
    const owner = await createUser()
    const source = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    await setPassword(owner.id, source.docId, 'correct-horse')
    const staleHash = await passwordHashOf(source.docId)
    await testDb().query(`UPDATE documents SET access_mode = 'private' WHERE doc_id = $1`, [source.docId])
    expect(await passwordHashOf(source.docId)).toBe(staleHash)

    const client = await loggedInClient(owner.id)
    const res = await client.post(`/api/docs/${source.docId}/duplicate`)
    expect(res.status).toBe(200)
    const { docId } = await res.json() as { docId: string }
    expect(await passwordHashOf(docId)).toBeNull()
  })

  it('duplicating a password-protected doc keeps its password', async () => {
    const owner = await createUser()
    const source = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    await setPassword(owner.id, source.docId, 'correct-horse')
    const client = await loggedInClient(owner.id)
    const res = await client.post(`/api/docs/${source.docId}/duplicate`)
    expect(res.status).toBe(200)
    const { docId } = await res.json() as { docId: string }
    expect(await passwordHashOf(docId)).toBe(await passwordHashOf(source.docId))
  })
})

describe('workspace viewer on an open-edit doc stays read-only server-side', () => {
  beforeEach(async () => {
    await resetDb()
  })

  async function viewerSetup() {
    const owner = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, accessMode: 'open-edit' })
    return { viewerClient: await loggedInClient(viewer.id), doc }
  }

  it('token endpoint: read-only (baseline)', async () => {
    const { viewerClient, doc } = await viewerSetup()
    const res = await viewerClient.get(`/api/docs/${doc.docId}/token`)
    expect((await res.json() as { readOnly: boolean }).readOnly).toBe(true)
  })

  it('image upload request: 403', async () => {
    const { viewerClient, doc } = await viewerSetup()
    const res = await viewerClient.post('/api/upload/request', {
      docId: doc.docId,
      filename: 'x.png',
      contentType: 'image/png',
      size: 100
    })
    expect(res.status).toBe(403)
  })

  it('dictation token: 403', async () => {
    const { viewerClient, doc } = await viewerSetup()
    const res = await viewerClient.post('/api/ai/dictate/token', { docId: doc.docId })
    expect(res.status).toBe(403)
  })

  it('AI prompt: 403', async () => {
    const { viewerClient, doc } = await viewerSetup()
    const res = await viewerClient.post('/api/ai/prompt', { docId: doc.docId, prompt: 'Rewrite everything' })
    expect(res.status).toBe(403)
  })

  it('a logged-in non-member can still upload on an open-edit doc', async () => {
    const owner = await createUser()
    const passerBy = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
    const client = await loggedInClient(passerBy.id)
    const res = await client.post('/api/upload/request', {
      docId: doc.docId,
      filename: 'x.png',
      contentType: 'image/png',
      size: 100
    })
    expect(res.status).toBe(200)
  })
})

describe('server-side onboarding gate (legal surfaces on)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('refuses state changes until the user has accepted, then allows them', async () => {
    const user = await createUser({ freshOnboarding: true })
    const client = await loggedInClient(user.id)

    const blocked = await client.post('/api/docs', {})
    expect(blocked.status).toBe(403)
    expect((await blocked.json() as { data?: { code?: string } }).data?.code).toBe('onboarding/required')

    const blockedAi = await client.post('/api/ai/prompt', { docId: 'whatever', prompt: 'hi' })
    expect(blockedAi.status).toBe(403)

    // Reads still work, so the app can render the gate.
    expect((await client.get('/api/user/account-status')).status).toBe(200)

    const accept = await client.post('/api/user/onboarding-accept', {
      ageConfirmed: true,
      privacyVersion: PRIVACY_VERSION,
      tosVersion: TOS_VERSION,
      locale: 'en'
    })
    expect(accept.status).toBe(200)

    const allowed = await client.post('/api/docs', {})
    expect(allowed.status).toBe(200)
  })

  it('a stale privacy acceptance blocks again until re-accepted', async () => {
    const user = await createUser()
    await testDb().query('UPDATE users SET privacy_version_accepted = $1 WHERE id = $2', [PRIVACY_VERSION - 1, user.id])
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/docs', {})
    expect(res.status).toBe(403)
  })

  it('leaving is always possible: deletion request is exempt', async () => {
    const user = await createUser({ freshOnboarding: true })
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/user/delete', {})
    expect(res.status).not.toBe(403)
  })

  it('anonymous callers are not gated', async () => {
    const res = await anonClient().post('/api/docs', {})
    expect(res.status).toBe(200)
  })
})

describe('Origin check on state-changing requests', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('refuses a foreign Origin', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/docs', {}, { headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
    expect((await res.json() as { data?: { code?: string } }).data?.code).toBe('csrf/origin-mismatch')
  })

  it('refuses a cross-site Sec-Fetch-Site without Origin', async () => {
    const res = await anonClient().post('/api/docs', {}, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(res.status).toBe(403)
  })

  it('allows the app\'s own origin', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/docs', {}, { headers: { origin: TEST_BASE_URL } })
    expect(res.status).toBe(200)
  })

  it('does not apply to reads', async () => {
    const doc = await createDoc({ accessMode: 'open-edit' })
    const res = await anonClient().get(`/api/docs/${doc.docId}/token`, { headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(200)
  })
})

describe('POST /api/consent payload bounds', () => {
  beforeEach(async () => {
    await resetDb()
  })

  async function consentRows(): Promise<number> {
    const r = await testDb().query<{ c: string }>('SELECT COUNT(*) AS c FROM consent_log')
    return Number(r.rows[0]?.c ?? 0)
  }

  it('writes at most one row per purpose per submission', async () => {
    const decisions = Array.from({ length: 10 }, (_, i) => ({ purpose: 'analytics', granted: i % 2 === 0 }))
    const res = await anonClient().post('/api/consent', { decisions })
    expect(res.status).toBe(200)
    expect((await res.json() as { recorded: number }).recorded).toBe(1)
    expect(await consentRows()).toBe(1)
  })

  it('refuses an oversized decisions array without writing', async () => {
    const decisions = Array.from({ length: 1000 }, () => ({ purpose: 'essential', granted: true }))
    const res = await anonClient().post('/api/consent', { decisions })
    expect(res.status).toBe(400)
    expect(await consentRows()).toBe(0)
  })
})
