import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { S3Client, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createUser, createWorkspace, setMemberRole } from '../setup/fixtures'

// POST /api/workspaces/:wsId/knowledge/confirm must only act on an upload
// that upload-request issued to the CALLER in THIS workspace — mirror of
// the image `/api/upload/confirm` ownership rule. Before, any editor who
// learnt another member's knowledgeId + key could confirm it as their own
// or make confirm delete that member's freshly uploaded original.

const s3 = new S3Client({
  endpoint: 'http://127.0.0.1:8334',
  region: 'us-east-1',
  credentials: { accessKeyId: 'ypad-access-key', secretAccessKey: 'ypad-secret-key' },
  forcePathStyle: true
})
const BUCKET = 'ypad'
const seeded: string[] = []

interface Issued {
  knowledgeId: string
  uploadUrl: string
  s3Key: string
  ext: string
  mimeType: string
}

async function exists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

async function requestAndUpload(userId: number, wsId: string, filename: string, body: string): Promise<Issued> {
  const client = await loggedInClient(userId)
  const res = await client.post(`/api/workspaces/${wsId}/knowledge/upload-request`, {
    filename,
    size: Buffer.byteLength(body)
  })
  expect(res.status).toBe(200)
  const issued = await res.json() as Issued
  seeded.push(issued.s3Key)
  const put = await fetch(issued.uploadUrl, { method: 'PUT', headers: { 'Content-Type': issued.mimeType }, body })
  expect(put.status, await put.text()).toBe(200)
  return issued
}

function confirmBody(issued: Issued, filename: string) {
  return { knowledgeId: issued.knowledgeId, s3Key: issued.s3Key, filename, ext: issued.ext, mimeType: issued.mimeType }
}

async function knowledgeRows(wsId: string): Promise<Array<{ knowledge_id: string, uploader_id: number | null }>> {
  const r = await testDb().query<{ knowledge_id: string, uploader_id: number | null }>(
    'SELECT knowledge_id, uploader_id FROM workspace_knowledge WHERE workspace_id = $1',
    [wsId]
  )
  return r.rows
}

describe('knowledge confirm requires the caller\'s own pending upload', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterEach(async () => {
    for (const key of seeded.splice(0)) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
      } catch { /* already gone */ }
    }
  })

  it('another editor cannot confirm (or delete) someone else\'s upload', async () => {
    const owner = await createUser()
    const other = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, other.id, 'editor')

    const issued = await requestAndUpload(owner.id, ws.workspaceId, 'notes.txt', 'Quarterly notes, plain text.\n')

    const otherClient = await loggedInClient(other.id)
    const stolen = await otherClient.post(`/api/workspaces/${ws.workspaceId}/knowledge/confirm`, confirmBody(issued, 'notes.txt'))
    expect(stolen.status).toBe(404)
    expect(await exists(issued.s3Key)).toBe(true)
    expect(await knowledgeRows(ws.workspaceId)).toEqual([])

    // The real uploader can still confirm it.
    const ownerClient = await loggedInClient(owner.id)
    const ok = await ownerClient.post(`/api/workspaces/${ws.workspaceId}/knowledge/confirm`, confirmBody(issued, 'notes.txt'))
    expect(ok.status).toBe(200)
    expect(await knowledgeRows(ws.workspaceId)).toEqual([{ knowledge_id: issued.knowledgeId, uploader_id: owner.id }])
  })

  it('a second confirm of the same upload is a 404 and leaves the object alone', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const issued = await requestAndUpload(owner.id, ws.workspaceId, 'notes.txt', 'Some notes.\n')
    const client = await loggedInClient(owner.id)

    const first = await client.post(`/api/workspaces/${ws.workspaceId}/knowledge/confirm`, confirmBody(issued, 'notes.txt'))
    expect(first.status).toBe(200)
    const second = await client.post(`/api/workspaces/${ws.workspaceId}/knowledge/confirm`, confirmBody(issued, 'notes.txt'))
    expect(second.status).toBe(404)
    expect(await knowledgeRows(ws.workspaceId)).toHaveLength(1)
  })

  it('a confirm for an upload that was never issued is a 404', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const client = await loggedInClient(owner.id)
    const knowledgeId = 'z'.repeat(12)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/knowledge/confirm`, {
      knowledgeId,
      s3Key: `workspaces/${ws.workspaceId}/knowledge/${knowledgeId}.txt`,
      filename: 'x.txt',
      ext: 'txt',
      mimeType: 'text/plain'
    })
    expect(res.status).toBe(404)
  })
})
