import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { strToU8, zipSync } from 'fflate'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient, type TestClient } from '../setup/client'
import { createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { TEST_BILLING_OFF_BASE_URL, TEST_GITHUB_IMPORT_PORT } from '../setup/env'

// Bulk imports over HTTP: the limits checked before anything is uploaded
// (target, one active import, plan caps, imports per day, paths), the
// browser's presigned uploads into the test SeaweedFS, cancel, and two runs
// end to end through the app's own `import-worker` sweeper (every 15 s): an
// upload and a GitHub repository served by a local fake GitHub. File
// handling in depth (DOCX images, zips, zip bombs) is pinned at the repos
// tier (tests/repos/importWorker.test.ts), where the worker runs directly.

interface JobView { jobId: string, status: string, total: number, done: number, failed: number, skipped: number, error: string | null }

async function code(res: Response): Promise<{ code?: string, field?: string }> {
  return ((await res.json()) as { data?: { code?: string, field?: string } }).data ?? {}
}

async function createJob(c: TestClient, body: Record<string, unknown>) {
  return c.post('/api/imports', { workspaceId: null, folderId: null, ...body })
}

async function waitForJob(c: TestClient, jobId: string, timeoutMs = 60_000): Promise<{ job: JobView, problems: Array<{ path: string, status: string, reason: string | null }> }> {
  const start = Date.now()
  for (;;) {
    const res = await c.get(`/api/imports/${jobId}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { job: JobView, problems: Array<{ path: string, status: string, reason: string | null }> }
    if (['done', 'failed', 'cancelled'].includes(body.job.status)) return body
    if (Date.now() - start > timeoutMs) throw new Error(`import ${jobId} still ${body.job.status} after ${timeoutMs} ms`)
    await new Promise(r => setTimeout(r, 1000))
  }
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

describe('POST /api/imports: limits before upload', () => {
  beforeEach(resetDb)

  it('refuses a second import while one is active, and paths that climb out', async () => {
    const alice = await createUser()
    const a = await loggedInClient(alice.id)
    const first = await createJob(a, { source: 'upload', files: [{ path: 'a.md', size: 5 }] })
    expect(first.status).toBe(200)
    const second = await createJob(a, { source: 'upload', files: [{ path: 'b.md', size: 5 }] })
    expect(second.status).toBe(409)
    expect((await code(second)).code).toBe('import/job-active')

    const bob = await createUser()
    const b = await loggedInClient(bob.id)
    const climb = await createJob(b, { source: 'upload', files: [{ path: '../etc/passwd.md', size: 5 }] })
    expect(climb.status).toBe(400)
    expect((await code(climb)).code).toBe('import/path-invalid')
    const nothing = await createJob(b, { source: 'upload', files: [{ path: 'tool.exe', size: 5 }, { path: '.hidden/x.md', size: 5 }] })
    expect(nothing.status).toBe(400)
    expect((await code(nothing)).code).toBe('import/nothing-to-import')
    const github = await createJob(b, { source: 'github', url: 'https://gitlab.com/o/r' })
    expect(github.status).toBe(400)
    expect((await code(github)).code).toBe('import/github-url-invalid')
  })

  it('needs the editor role for a workspace import and a folder of that workspace', async () => {
    const admin = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(admin.id)
    const other = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const v = await loggedInClient(viewer.id)
    const refused = await createJob(v, { source: 'upload', workspaceId: ws.workspaceId, files: [{ path: 'a.md', size: 5 }] })
    expect(refused.status).toBe(403)
    const a = await loggedInClient(admin.id)
    const otherFolder = ((await (await a.post(`/api/workspaces/${other.workspaceId}/folders`, { name: 'Elsewhere' })).json()) as { folder: { folderId: string } }).folder.folderId
    const wrongFolder = await createJob(a, { source: 'upload', workspaceId: ws.workspaceId, folderId: otherFolder, files: [{ path: 'a.md', size: 5 }] })
    expect(wrongFolder.status).toBe(404)
    expect((await code(wrongFolder)).code).toBe('folder/not-found')
  })

  it('applies the plan caps: files and bytes per import, imports per day', async () => {
    const alice = await createUser()
    const a = await loggedInClient(alice.id, undefined, TEST_BILLING_OFF_BASE_URL)
    const tooMany = await createJob(a, { source: 'upload', files: Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.md`, size: 10 })) })
    expect(tooMany.status).toBe(409)
    expect(await code(tooMany)).toMatchObject({ code: 'plan/limit-reached', field: 'importFilesPerJob' })
    const tooBig = await createJob(a, { source: 'upload', files: [1, 2, 3].map(i => ({ path: `a${i}.zip`, size: 90 * 1024 * 1024 })) })
    expect(tooBig.status).toBe(409)
    expect(await code(tooBig)).toMatchObject({ code: 'plan/limit-reached', field: 'importBytesPerJob' })

    await testDb().query(`
      INSERT INTO import_jobs (job_id, user_id, source, status, finished_at)
      SELECT 'old' || g, $1, 'upload', 'done', now() FROM generate_series(1, 10) g`, [alice.id])
    const perDay = await createJob(a, { source: 'upload', files: [{ path: 'a.md', size: 10 }] })
    expect(perDay.status).toBe(409)
    expect(await code(perDay)).toMatchObject({ code: 'plan/limit-reached', field: 'importJobsPerDay' })
  })

  it('cancels an import that has not started, and only the importer sees it', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const a = await loggedInClient(alice.id)
    const b = await loggedInClient(bob.id)
    const { jobId } = await (await createJob(a, { source: 'upload', files: [{ path: 'a.md', size: 5 }] })).json() as { jobId: string }
    expect((await b.get(`/api/imports/${jobId}`)).status).toBe(404)
    expect((await b.post(`/api/imports/${jobId}/cancel`)).status).toBe(404)
    expect((await b.post(`/api/imports/${jobId}/start`)).status).toBe(409)
    const cancel = await a.post(`/api/imports/${jobId}/cancel`)
    expect(await cancel.json()).toMatchObject({ success: true, status: 'cancelled' })
    expect((await a.post(`/api/imports/${jobId}/start`)).status).toBe(409)
    // The slot is free again.
    expect((await createJob(a, { source: 'upload', files: [{ path: 'a.md', size: 5 }] })).status).toBe(200)
  })
})

describe('imports end to end', () => {
  let github: Server
  const repoZip = zipSync({
    'handbook-main/README.md': strToU8('# Handbook\n\nStart with [onboarding](people/onboarding.md).\n'),
    'handbook-main/people/onboarding.md': strToU8('# Onboarding\n\nWelcome aboard.\n')
  })

  beforeAll(async () => {
    github = createServer((req, res) => {
      if (req.url === '/api/repos/acme/handbook') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ default_branch: 'main' }))
      } else if (req.url === '/codeload/acme/handbook/zip/main') {
        res.writeHead(200, { 'content-type': 'application/zip' })
        res.end(Buffer.from(repoZip))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>(resolve => github.listen(TEST_GITHUB_IMPORT_PORT, '127.0.0.1', resolve))
  })

  afterAll(async () => {
    await new Promise<void>(resolve => github.close(() => resolve()))
  })

  beforeEach(resetDb)

  it('uploads files to their presigned keys, starts, and the worker turns them into documents', async () => {
    const alice = await createUser()
    const a = await loggedInClient(alice.id)
    const files = {
      'Notes/plan.md': strToU8('# Plan\n\n![dot](img/dot.png) and [ideas](ideas.md)\n'),
      'Notes/ideas.md': strToU8('# Ideas\n'),
      'Notes/img/dot.png': new Uint8Array(PNG),
      'Notes/missing.md': strToU8('# Never uploaded\n'),
      'Notes/program.exe': strToU8('MZ')
    }
    const res = await createJob(a, { source: 'upload', files: Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.byteLength })) })
    expect(res.status, await res.clone().text()).toBe(200)
    const created = await res.json() as { jobId: string, uploads: Array<{ path: string, url: string }>, skipped: number }
    expect(created.skipped).toBe(1)
    expect(created.uploads.map(u => u.path).toSorted()).toEqual(['Notes/ideas.md', 'Notes/img/dot.png', 'Notes/missing.md', 'Notes/plan.md'])
    for (const upload of created.uploads) {
      if (upload.path === 'Notes/missing.md') continue
      const bytes = files[upload.path as keyof typeof files]
      const put = await fetch(upload.url, { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' } })
      expect(put.status, upload.path).toBe(200)
    }
    expect((await a.post(`/api/imports/${created.jobId}/start`)).status).toBe(200)

    const { job, problems } = await waitForJob(a, created.jobId)
    expect(job).toMatchObject({ status: 'done', total: 3, done: 2, failed: 1 })
    expect(problems).toEqual(expect.arrayContaining([
      { path: 'Notes/missing.md', status: 'failed', reason: 'not-uploaded' },
      { path: 'Notes/program.exe', status: 'skipped', reason: 'unsupported' }
    ]))

    const docs = (await testDb().query<{ doc_id: string, title: string, folder_id: string | null }>(`SELECT doc_id, title, folder_id FROM documents ORDER BY title`)).rows
    expect(docs.map(d => d.title)).toEqual(['Ideas', 'Plan'])
    const plan = docs.find(d => d.title === 'Plan')!
    const ideas = docs.find(d => d.title === 'Ideas')!
    const folder = (await testDb().query<{ name: string }>('SELECT name FROM folders WHERE folder_id = $1', [plan.folder_id])).rows[0]
    expect(folder?.name).toBe('Notes')
    const body = (await testDb().query<{ body: string }>('SELECT body FROM document_search WHERE doc_id = $1', [plan.doc_id])).rows[0]?.body
    expect(body).toContain(`(/d/${ideas.doc_id})`)
    expect(body).toMatch(new RegExp(`/api/files/${plan.doc_id}/[A-Za-z0-9_-]+\\.png`))
    // The stored image is served to the owner.
    const image = body!.match(/\/api\/files\/[^)]+/)![0]
    expect((await a.get(image)).status).toBe(302)

    const list = await (await a.get('/api/imports?workspaceId=personal')).json() as { jobs: JobView[] }
    expect(list.jobs.map(j => j.jobId)).toEqual([created.jobId])
  }, 90_000)

  it('imports a public GitHub repository', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const a = await loggedInClient(admin.id)
    const res = await createJob(a, { source: 'github', workspaceId: ws.workspaceId, url: 'https://github.com/acme/handbook' })
    expect(res.status, await res.clone().text()).toBe(200)
    const { jobId } = await res.json() as { jobId: string }
    const { job } = await waitForJob(a, jobId)
    expect(job).toMatchObject({ status: 'done', total: 2, done: 2 })
    const page = await (await a.get(`/api/workspaces/${ws.workspaceId}/documents?folder=all`)).json() as { items: Array<{ title: string }> }
    expect(page.items.map(i => i.title).toSorted()).toEqual(['Handbook', 'Onboarding'])
    const audit = (await testDb().query(`SELECT 1 FROM audit_log WHERE action = 'import.completed' AND workspace_id = $1`, [ws.workspaceId])).rowCount
    expect(audit).toBe(1)
  }, 90_000)
})
