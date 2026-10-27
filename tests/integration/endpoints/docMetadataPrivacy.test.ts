import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'

// Metadata of docs the caller can't open must not leak.
//
// `GET /api/docs/:id/meta` and the denied branch of `GET /token` apply
// the same decision (`decideTokenAccess`): a forbidden / password-gated
// caller learns only what the editor needs to draw the gate — never the
// title, description, owner, workspace, theme or `(+)` sponsor.

const SECRET_TITLE = 'Secret merger plan'
const SECRET_DESCRIPTION = 'Acquisition of a competitor in Q3'

const LEAKY_FIELDS = ['title', 'description', 'ownerId', 'theme', 'audience', 'language', 'templateId', 'wordCount', 'workspaceId']

function expectNoLeak(body: Record<string, unknown>) {
  const json = JSON.stringify(body)
  expect(json).not.toContain(SECRET_TITLE)
  expect(json).not.toContain(SECRET_DESCRIPTION)
}

describe('GET /api/docs/:id/meta — access-gated', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('private doc: anonymous and non-member callers get only the gate shape', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private', title: SECRET_TITLE, description: SECRET_DESCRIPTION })

    for (const client of [anonClient(), await loggedInClient(stranger.id)]) {
      const res = await client.get(`/api/docs/${doc.docId}/meta`)
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body).toMatchObject({ accessMode: 'private', forbidden: true, requiresPassword: false })
      for (const f of LEAKY_FIELDS) expect(body).not.toHaveProperty(f)
      expectNoLeak(body)
    }
  })

  it('password-protected doc: gate shape says a password is required, nothing else', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'password-protected', title: SECRET_TITLE, description: SECRET_DESCRIPTION })
    const res = await anonClient().get(`/api/docs/${doc.docId}/meta`)
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({ accessMode: 'password-protected', hasPassword: true, requiresPassword: true, forbidden: false })
    for (const f of LEAKY_FIELDS) expect(body).not.toHaveProperty(f)
    expectNoLeak(body)
  })

  it('owner and workspace members get the full metadata', async () => {
    const owner = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, accessMode: 'private', title: SECRET_TITLE })

    for (const client of [await loggedInClient(owner.id), await loggedInClient(viewer.id)]) {
      const body = await (await client.get(`/api/docs/${doc.docId}/meta`)).json() as Record<string, unknown>
      expect(body).toMatchObject({ title: SECRET_TITLE, ownerId: owner.id, forbidden: false })
    }
  })

  it('open docs stay public', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view', title: 'Public notes' })
    const body = await (await anonClient().get(`/api/docs/${doc.docId}/meta`)).json() as Record<string, unknown>
    expect(body).toMatchObject({ title: 'Public notes', accessMode: 'open-view' })
  })

  it('a visitor who unlocked a password doc gets the metadata with the unlock JWT', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private', title: SECRET_TITLE, description: SECRET_DESCRIPTION })
    const ownerClient = await loggedInClient(owner.id)
    expect((await ownerClient.post(`/api/docs/${doc.docId}/password`, { action: 'set', password: 'correct horse' })).status).toBe(200)

    const visitor = anonClient()
    const verify = await visitor.post(`/api/docs/${doc.docId}/password`, { action: 'verify', password: 'correct horse' })
    expect(verify.status).toBe(200)
    const { token } = await verify.json() as { token: string }

    const res = await visitor.get(`/api/docs/${doc.docId}/meta`, { headers: { authorization: `Bearer ${token}` } })
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({ title: SECRET_TITLE, description: SECRET_DESCRIPTION, requiresPassword: false })

    // A token for another doc doesn't unlock this one.
    const other = await createDoc({ ownerId: owner.id, accessMode: 'private', title: 'Other secret' })
    const res2 = await visitor.get(`/api/docs/${other.docId}/meta`, { headers: { authorization: `Bearer ${token}` } })
    expect(await res2.json()).toMatchObject({ forbidden: true })
  })

  it('unknown doc is 404', async () => {
    expect((await anonClient().get('/api/docs/does-not-exist/meta')).status).toBe(404)
  })
})

describe('GET /api/docs/:id/token — denied responses carry no metadata', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('forbidden private doc: no title-derived body, description, owner, workspace, theme or sponsor', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const doc = await createDoc({
      ownerId: owner.id,
      workspaceId: ws.workspaceId,
      accessMode: 'private',
      title: SECRET_TITLE,
      description: SECRET_DESCRIPTION,
      templateId: 'meeting-notes'
    })
    const res = await anonClient().get(`/api/docs/${doc.docId}/token`)
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({
      token: null,
      forbidden: true,
      ownerId: null,
      workspaceId: null,
      workspaceRole: null,
      workspaceBillingOwner: null,
      theme: null,
      initialBody: null,
      canDelete: false
    })
    expect(body).not.toHaveProperty('description')
    expect(body).not.toHaveProperty('audience')
    expectNoLeak(body)
  })

  it('password-gated doc: same minimal shape with requiresPassword', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'password-protected', title: SECRET_TITLE, description: SECRET_DESCRIPTION })
    const body = await (await anonClient().get(`/api/docs/${doc.docId}/token`)).json() as Record<string, unknown>
    expect(body).toMatchObject({ token: null, requiresPassword: true, ownerId: null, theme: null })
    expectNoLeak(body)
  })
})
