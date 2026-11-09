import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient, type TestClient } from '../setup/client'
import { fakeOpenAiBaseUrl } from '../setup/env'
import { byokUser, fakeRequests, resetFake, uniqueKey, waitFor } from '../setup/byok'

// "Create a design from a document", end to end:
//   upload-request (vision gate) → presigned PUT → start (claim, sniff,
//   delete the original, audit) → markitdown-test `/design/extract` →
//   fake-openai-test answers `propose_design` (tests/fixtures/fake-openai)
//   → renderer-test renders the sample (render-bootstrap serves it from
//   Valkey) → a comparison round → job result → saved as a theme.
// The fake provider answers round 2 with `matches_original: true`, so a
// run makes exactly two model calls.

const FAKE = fakeOpenAiBaseUrl()
const FIXTURES = resolve(__dirname, '../../fixtures/design-import')
const s3 = new S3Client({
  endpoint: 'http://127.0.0.1:8334',
  region: 'us-east-1',
  credentials: { accessKeyId: 'ypad-access-key', secretAccessKey: 'ypad-secret-key' },
  forcePathStyle: true
})

interface UploadTicket { uploadId: string, uploadUrl: string, mimeType: string }
interface JobView {
  phase: string
  round: number
  format: string
  result?: {
    theme: { body: { font: string }, headings: { font: string }, color: { brand: string }, customCss?: string }
    name: string
    description: string
    preview: string[]
    original: string[]
    fonts: Array<{ from: string, to: string, exact: boolean }>
    rounds: number
  }
  error?: { code: string, message: string }
}
interface ErrorBody { data?: { code?: string } }

async function visionUser(supportsVision = true): Promise<{ id: number, client: TestClient }> {
  const u = await byokUser()
  const client = await loggedInClient(u.id)
  const saved = await client.put('/api/user/ai-providers/chat', { baseUrl: FAKE, model: 'fake-chat', apiKey: uniqueKey('design'), supportsVision })
  expect(saved.status).toBe(200)
  return { id: u.id, client }
}

async function upload(client: TestClient, filename: string, bytes: Uint8Array): Promise<UploadTicket> {
  const res = await client.post('/api/themes/from-document/upload-request', { filename, size: bytes.byteLength })
  expect(res.status, await res.clone().text()).toBe(200)
  const ticket: UploadTicket = await res.json()
  const put = await fetch(ticket.uploadUrl, { method: 'PUT', headers: { 'Content-Type': ticket.mimeType }, body: bytes })
  expect(put.status).toBe(200)
  return ticket
}

async function stagingObjectExists(userId: number, uploadId: string, ext: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: 'ypad', Key: `design-imports/${userId}/staging/${uploadId}.${ext}` }))
    return true
  } catch {
    return false
  }
}

async function finished(client: TestClient, jobId: string): Promise<JobView> {
  return waitFor(async () => {
    const res = await client.get(`/api/themes/from-document/jobs/${jobId}`)
    if (res.status !== 200) return null
    const job: JobView = await res.json()
    return job.phase === 'done' || job.phase === 'error' ? job : null
  }, 150_000, 'the design run')
}

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(FIXTURES, name)))
}

describe('design from a document', () => {
  beforeEach(async () => {
    await resetDb()
    await resetFake()
  })

  it('requires login', async () => {
    expect((await anonClient().post('/api/themes/from-document/upload-request', { filename: 'a.pdf', size: 10 })).status).toBe(401)
    expect((await anonClient().post('/api/themes/from-document/start', { uploadId: 'x' })).status).toBe(401)
    expect((await anonClient().get('/api/themes/from-document/jobs/abc')).status).toBe(401)
  })

  it('needs a chat model that reads images', async () => {
    const { client } = await visionUser(false)
    const res = await client.post('/api/themes/from-document/upload-request', { filename: 'a.pdf', size: 10 })
    expect(res.status).toBe(409)
    const body: ErrorBody = await res.json()
    expect(body.data?.code).toBe('design-import/no-vision')
  })

  it('accepts only PDF / DOCX up to 20 MB', async () => {
    const { client } = await visionUser()
    expect((await client.post('/api/themes/from-document/upload-request', { filename: 'a.pptx', size: 10 })).status).toBe(415)
    expect((await client.post('/api/themes/from-document/upload-request', { filename: 'a.pdf', size: 21 * 1024 * 1024 })).status).toBe(413)
  })

  it('PDF: extracts, proposes, renders, compares — and the result saves as a theme', async () => {
    const { id, client } = await visionUser()
    const ticket = await upload(client, 'report-cover.pdf', fixture('report-cover.pdf'))
    const start = await client.post('/api/themes/from-document/start', { uploadId: ticket.uploadId })
    expect(start.status, await start.clone().text()).toBe(200)
    const { jobId }: { jobId: string } = await start.json()

    // The original is gone from storage as soon as the server read it.
    expect(await stagingObjectExists(id, ticket.uploadId, 'pdf')).toBe(false)

    const job = await finished(client, jobId)
    expect(job.error).toBeUndefined()
    expect(job.phase).toBe('done')
    const result = job.result
    expect(result?.name).toBe('Fake navy report')
    expect(result?.theme.body.font).toBe('Lato')
    expect(result?.theme.headings.font).toBe('PT Serif')
    expect(result?.theme.customCss).toContain('#F28C28')
    expect(result?.original).toHaveLength(2)
    expect(result?.preview.length).toBeGreaterThan(0)
    expect(result?.fonts).toEqual(expect.arrayContaining([{ from: 'LiberationSans', to: 'TeX Gyre Heros', exact: false }]))
    expect(result?.rounds).toBe(2)

    // Round 1 sees the original's pages; round 2 also our render.
    const calls = (await fakeRequests()).filter(r => r.tools?.includes('propose_design'))
    expect(calls).toHaveLength(2)
    expect(calls[0]?.images).toBe(2)
    expect(calls[1]?.images).toBeGreaterThan(2)

    const audit = await testDb().query<{ metadata: { format?: string } }>(`SELECT metadata FROM audit_log WHERE action = 'design_import.started' AND scope_id = $1`, [String(id)])
    expect(audit.rows[0]?.metadata.format).toBe('pdf')

    // Another user can't read the job.
    const other = await byokUser()
    expect((await (await loggedInClient(other.id)).get(`/api/themes/from-document/jobs/${jobId}`)).status).toBe(404)

    // Save as a personal design: the theme passes the normal saved-theme gate.
    const saved = await client.post('/api/themes', { name: result?.name, description: result?.description, theme: result?.theme })
    expect(saved.status, await saved.clone().text()).toBe(200)
  }, 180_000)

  it('DOCX: styles only (no page pictures), fonts matched to served families', async () => {
    const { client } = await visionUser()
    const ticket = await upload(client, 'letter-serif.docx', fixture('letter-serif.docx'))
    const start = await client.post('/api/themes/from-document/start', { uploadId: ticket.uploadId })
    expect(start.status).toBe(200)
    const { jobId }: { jobId: string } = await start.json()
    const job = await finished(client, jobId)
    expect(job.format).toBe('docx')
    expect(job.result?.original).toEqual([])
    expect(job.result?.fonts).toEqual(expect.arrayContaining([
      { from: 'EB Garamond', to: 'EB Garamond', exact: true },
      { from: 'Georgia', to: 'Merriweather', exact: false }
    ]))
    const calls = (await fakeRequests()).filter(r => r.tools?.includes('propose_design'))
    expect(calls[0]?.images).toBe(0)
  }, 180_000)

  it('refuses bytes that are not what the name says, and deletes them', async () => {
    const { id, client } = await visionUser()
    const fake = new TextEncoder().encode('just some text, not a PDF at all')
    const ticket = await upload(client, 'notes.pdf', fake)
    const start = await client.post('/api/themes/from-document/start', { uploadId: ticket.uploadId })
    expect(start.status).toBe(415)
    expect(await stagingObjectExists(id, ticket.uploadId, 'pdf')).toBe(false)
  })

  it('an upload can only be started once, and only by its owner', async () => {
    const { client } = await visionUser()
    const ticket = await upload(client, 'brochure-modern.pdf', fixture('brochure-modern.pdf'))
    const stranger = await visionUser()
    expect((await stranger.client.post('/api/themes/from-document/start', { uploadId: ticket.uploadId })).status).toBe(404)
    const first = await client.post('/api/themes/from-document/start', { uploadId: ticket.uploadId })
    expect(first.status).toBe(200)
    expect((await client.post('/api/themes/from-document/start', { uploadId: ticket.uploadId })).status).toBe(404)
    const { jobId }: { jobId: string } = await first.json()
    await finished(client, jobId)
  }, 180_000)
})
