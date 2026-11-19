import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import jwt from 'jsonwebtoken'
import WebSocket from 'ws'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { newProvider } from '../../helpers/hocuspocus'
import { Awareness } from 'y-protocols/awareness'
import { resetDb } from '../setup/db'
import { createDoc, createUser } from '../setup/fixtures'
import { loggedInClient } from '../setup/client'
import { TEST_JWT_SECRET, TEST_SYNC_PORT } from '../setup/env'
import { anchorRange, readSuggestions, suggestionsMap } from '../../../shared/utils/suggestions/ySuggestions'
import type { SuggestionRecord } from '../../../shared/utils/suggestions/record'

// Suggestion mode end to end, against the real app and sync-test
// container:
//   - the update guard lets a suggest-only connection write its own
//     suggestions but closes it (`invalid-suggestion`) when it touches
//     the text, and a read-only connection stays read-only;
//   - the token endpoint issues suggest-only tokens per the document's
//     suggestion settings (required, exempt roles, viewers may suggest);
//   - only people who edit directly can accept or reject, and accepting
//     changes the text for everyone.

const WS_URL = `ws://127.0.0.1:${TEST_SYNC_PORT}`

interface Identity {
  userId: string
  userName: string | null
  readOnly?: boolean
  suggestOnly?: boolean
}

interface Client {
  doc: Y.Doc
  provider: HocuspocusProvider
  closes: Array<{ code: number, reason: string }>
  synced: Promise<void>
}

const openClients: Client[] = []

function connectWith(docId: string, token: string): Client {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  const closes: Array<{ code: number, reason: string }> = []
  let resolveSynced: () => void = () => {}
  let rejectSynced: (e: Error) => void = () => {}
  const synced = new Promise<void>((resolve, reject) => {
    resolveSynced = resolve
    rejectSynced = reject
  })
  const provider = newProvider({
    url: WS_URL,
    name: docId,
    document: doc,
    awareness,
    token,
    WebSocketPolyfill: WebSocket,
    onSynced: () => resolveSynced(),
    onAuthenticationFailed: ({ reason }) => rejectSynced(new Error(`auth failed: ${reason}`)),
    onClose: ({ event }) => {
      closes.push({ code: event.code, reason: event.reason })
    }
  })
  const client = { doc, provider, closes, synced }
  openClients.push(client)
  return client
}

function connect(docId: string, identity: Identity): Client {
  const token = jwt.sign({
    docId,
    userId: identity.userId,
    userName: identity.userName,
    readOnly: identity.readOnly ?? false,
    ...(identity.suggestOnly ? { suggestOnly: true } : {})
  }, TEST_JWT_SECRET, { expiresIn: '10m' })
  return connectWith(docId, token)
}

async function waitFor<T>(probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await probe()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    await new Promise(r => setTimeout(r, 100))
  }
}

async function freshCopy(docId: string): Promise<Y.Doc> {
  const c = connect(docId, { userId: 'anonymous', userName: null, readOnly: true })
  await c.synced
  return c.doc
}

function suggestion(doc: Y.Doc, authorId: number | null, over: Partial<SuggestionRecord> = {}): SuggestionRecord {
  const id = over.id ?? `sugg-${Math.random().toString(36).slice(2, 10)}`
  return {
    v: 1,
    id,
    ...anchorRange(doc.getText('content'), 0, 5),
    text: 'Howdy',
    deleted: 'Hello',
    authorId,
    authorName: 'Sam',
    authorAvatarSeed: null,
    authorPrincipal: null,
    color: '#7A8C7E',
    createdAt: 1,
    updatedAt: 1,
    groupId: null,
    jobId: null,
    ...over
  }
}

/** A document whose text is "Hello world", written by its owner. */
async function seededDoc(opts: { ownerId: number, accessMode?: 'open-edit' | 'open-view' | 'private' }): Promise<string> {
  const doc = await createDoc({ ownerId: opts.ownerId, accessMode: opts.accessMode ?? 'open-edit' })
  const owner = connect(doc.docId, { userId: String(opts.ownerId), userName: 'Owner' })
  await owner.synced
  owner.doc.getText('content').insert(0, 'Hello world')
  await waitFor(async () => (await freshCopy(doc.docId)).getText('content').toString() === 'Hello world')
  return doc.docId
}

beforeEach(async () => {
  await resetDb()
})

afterEach(() => {
  for (const c of openClients.splice(0)) {
    c.provider.destroy()
    c.doc.destroy()
  }
})

describe('update guard on the WebSocket path', () => {
  it('a suggest-only connection stores its own suggestion', async () => {
    const owner = await createUser()
    const sam = await createUser()
    const docId = await seededDoc({ ownerId: owner.id })
    const c = connect(docId, { userId: String(sam.id), userName: 'Sam', suggestOnly: true })
    await c.synced
    const record = suggestion(c.doc, sam.id)
    suggestionsMap(c.doc).set(record.id, record)
    await waitFor(async () => readSuggestions(await freshCopy(docId)).some(s => s.record.id === record.id))
    expect(c.closes.filter(x => x.reason === 'invalid-suggestion')).toEqual([])
  })

  it('a suggest-only connection that types into the text is closed and nothing is stored', async () => {
    const owner = await createUser()
    const sam = await createUser()
    const docId = await seededDoc({ ownerId: owner.id })
    const c = connect(docId, { userId: String(sam.id), userName: 'Sam', suggestOnly: true })
    await c.synced
    c.doc.getText('content').insert(0, 'Hacked ')
    await waitFor(() => c.closes.find(x => x.reason === 'invalid-suggestion'))
    expect((await freshCopy(docId)).getText('content').toString()).toBe('Hello world')
  })

  it('a suggest-only connection cannot write a suggestion in someone else\'s name', async () => {
    const owner = await createUser()
    const sam = await createUser()
    const docId = await seededDoc({ ownerId: owner.id })
    const c = connect(docId, { userId: String(sam.id), userName: 'Sam', suggestOnly: true })
    await c.synced
    const forged = suggestion(c.doc, owner.id)
    suggestionsMap(c.doc).set(forged.id, forged)
    await waitFor(() => c.closes.find(x => x.reason === 'invalid-suggestion'))
    expect(readSuggestions(await freshCopy(docId))).toEqual([])
  })

  it('a read-only connection stays read-only, suggestions included', async () => {
    const owner = await createUser()
    const viewer = await createUser()
    const docId = await seededDoc({ ownerId: owner.id })
    const c = connect(docId, { userId: String(viewer.id), userName: 'Viewer', readOnly: true })
    await c.synced
    const record = suggestion(c.doc, viewer.id)
    suggestionsMap(c.doc).set(record.id, record)
    c.doc.getText('content').insert(0, 'X')
    // Give the server time to (not) apply it.
    await new Promise(r => setTimeout(r, 1500))
    const copy = await freshCopy(docId)
    expect(copy.getText('content').toString()).toBe('Hello world')
    expect(readSuggestions(copy)).toEqual([])
  })
})

describe('suggestion settings and the document token', () => {
  async function tokenOf(userId: number, docId: string) {
    const client = await loggedInClient(userId)
    const res = await client.get(`/api/docs/${docId}/token`)
    expect(res.status).toBe(200)
    const body = await res.json() as { token: string | null, readOnly: boolean, suggestOnly: boolean }
    const claims = body.token ? jwt.decode(body.token) as { readOnly?: boolean, suggestOnly?: boolean } : null
    return { ...body, claims }
  }

  it('required: visitors get suggest-only tokens, the owner keeps editing', async () => {
    const owner = await createUser()
    const sam = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
    const ownerClient = await loggedInClient(owner.id)
    const put = await ownerClient.put(`/api/docs/${doc.docId}/suggestion-settings`, { required: true })
    expect(put.status).toBe(200)

    const samToken = await tokenOf(sam.id, doc.docId)
    expect(samToken).toMatchObject({ readOnly: false, suggestOnly: true })
    expect(samToken.claims).toMatchObject({ readOnly: false, suggestOnly: true })

    const ownerToken = await tokenOf(owner.id, doc.docId)
    expect(ownerToken).toMatchObject({ readOnly: false, suggestOnly: false })
    expect(ownerToken.claims?.suggestOnly).toBeUndefined()
  })

  it('only the owner or a workspace admin changes the settings', async () => {
    const owner = await createUser()
    const sam = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
    const samClient = await loggedInClient(sam.id)
    const res = await samClient.put(`/api/docs/${doc.docId}/suggestion-settings`, { required: true })
    expect(res.status).toBe(403)
  })

  it('viewers may suggest: a signed-in open-view visitor gets a suggest-only token', async () => {
    const owner = await createUser()
    const viewer = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view' })
    expect(await tokenOf(viewer.id, doc.docId)).toMatchObject({ readOnly: true, suggestOnly: false })
    const ownerClient = await loggedInClient(owner.id)
    await ownerClient.put(`/api/docs/${doc.docId}/suggestion-settings`, { viewersMaySuggest: true })
    expect(await tokenOf(viewer.id, doc.docId)).toMatchObject({ readOnly: false, suggestOnly: true })
  })
})

describe('accepting and rejecting', () => {
  it('a suggester cannot accept; the owner accepts and the text changes for everyone', async () => {
    const owner = await createUser()
    const sam = await createUser()
    const docId = await seededDoc({ ownerId: owner.id })
    const ownerClient = await loggedInClient(owner.id)
    await ownerClient.put(`/api/docs/${docId}/suggestion-settings`, { required: true })

    const c = connect(docId, { userId: String(sam.id), userName: 'Sam', suggestOnly: true })
    await c.synced
    const record = suggestion(c.doc, sam.id)
    suggestionsMap(c.doc).set(record.id, record)
    await waitFor(async () => readSuggestions(await freshCopy(docId)).length === 1)

    const samClient = await loggedInClient(sam.id)
    const refused = await samClient.post(`/api/docs/${docId}/suggestions/resolve`, { action: 'accept', ids: [record.id] })
    expect(refused.status).toBe(403)
    expect((await refused.json() as { data?: { code?: string } }).data?.code).toBe('suggestion/review-not-allowed')

    const accepted = await ownerClient.post(`/api/docs/${docId}/suggestions/resolve`, { action: 'accept', ids: [record.id] })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ resolved: 1 })
    await waitFor(() => c.doc.getText('content').toString() === 'Howdy world')
    expect(readSuggestions(c.doc)).toEqual([])

    const activity = await ownerClient.get(`/api/docs/${docId}/activity`)
    const rows = await activity.json() as { entries?: Array<{ action: string }> } | Array<{ action: string }>
    const list = Array.isArray(rows) ? rows : rows.entries ?? []
    expect(list.map(r => r.action)).toContain('suggestion.accepted')
  })

  it('rejecting removes the suggestion and leaves the text alone', async () => {
    const owner = await createUser()
    const sam = await createUser()
    const docId = await seededDoc({ ownerId: owner.id })
    const c = connect(docId, { userId: String(sam.id), userName: 'Sam', suggestOnly: true })
    await c.synced
    const record = suggestion(c.doc, sam.id)
    suggestionsMap(c.doc).set(record.id, record)
    await waitFor(async () => readSuggestions(await freshCopy(docId)).length === 1)

    const ownerClient = await loggedInClient(owner.id)
    const res = await ownerClient.post(`/api/docs/${docId}/suggestions/resolve`, { action: 'reject' })
    expect(await res.json()).toMatchObject({ resolved: 1 })
    await waitFor(() => readSuggestions(c.doc).length === 0)
    expect(c.doc.getText('content').toString()).toBe('Hello world')
  })
})
