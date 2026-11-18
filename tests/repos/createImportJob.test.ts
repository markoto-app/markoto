import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { S3Client } from '@aws-sdk/client-s3'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import { createFolder } from '../../server/repos/folders'
import { listImportItems } from '../../server/repos/imports'
import { __mintWorkspaceAccess, __userActor } from '../../server/repos/proofs/testing'
import { asUser } from '../helpers/access'

// Starting a bulk import: the target and the plan limits are checked before
// anything is uploaded, the manifest is split into files to upload (each
// with its own presigned staging PUT) and skipped ones (with the reason),
// and one active import per user.

// Presigning needs no network: a client with fixed credentials signs offline.
vi.stubGlobal('usePresignS3Client', () => new S3Client({
  region: 'us-east-1',
  endpoint: 'http://s3.test',
  forcePathStyle: true,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
}))

// planLimitError builds its error with Nitro's auto-imported createError.
vi.stubGlobal('createError', (input: Record<string, unknown>) => Object.assign(new Error(String(input.message)), input))

const { createUploadImportJob, createGithubImportJob } = await import('../../server/utils/imports/createImportJob')

const personal = { workspaceId: null, folderId: null }

async function jobRow(jobId: string) {
  return (await testDb().query<{ status: string, total: number, skipped: number, total_bytes: string, source: string, source_ref: string | null, workspace_id: string | null, target_folder_id: string | null }>(
    'SELECT status, total, skipped, total_bytes, source, source_ref, workspace_id, target_folder_id FROM import_jobs WHERE job_id = $1', [jobId]
  )).rows[0]
}

async function finishAll(): Promise<void> {
  await testDb().query(`UPDATE import_jobs SET status = 'done', finished_at = now()`)
}

describe('createUploadImportJob', () => {
  beforeEach(resetDb)
  afterEach(() => vi.unstubAllEnvs())

  it('plans the upload: presigned staging keys for kept files, reasons for skipped ones', async () => {
    const alice = await createUser()
    const res = await createUploadImportJob(asUser(alice.id), personal, [
      { path: 'Notes/a.md', size: 100 },
      { path: 'Notes/img/logo.png', size: 2000 },
      { path: 'Notes/A.md', size: 50 }, // same path, other case: listed once
      { path: 'Notes/report.docx', size: 300 },
      { path: 'Notes/tool.exe', size: 10 },
      { path: 'Notes/.DS_Store', size: 10 },
      { path: 'Notes/empty.md', size: 0 },
      { path: 'Notes/huge.png', size: 500 * 1024 * 1024 }
    ])
    expect(res.skipped).toBe(4)
    expect(res.uploads.map(u => u.path).toSorted()).toEqual(['Notes/a.md', 'Notes/img/logo.png', 'Notes/report.docx'])
    for (const u of res.uploads) {
      const url = new URL(u.url)
      expect(url.pathname).toContain(`/imports/${res.jobId}/${u.itemId}`)
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type')
    }

    const job = await jobRow(res.jobId)
    expect(job).toMatchObject({ status: 'uploading', total: 2, skipped: 4, source: 'upload', workspace_id: null })
    expect(Number(job!.total_bytes)).toBe(2400)

    const items = await listImportItems(asUser(alice.id), res.jobId, { problemsOnly: false, limit: 100 })
    const reasons = Object.fromEntries(items.filter(i => i.status === 'skipped').map(i => [i.relativePath, i.reason]))
    expect(reasons).toEqual({
      'Notes/tool.exe': 'unsupported',
      'Notes/.DS_Store': 'unsupported',
      'Notes/empty.md': 'unsupported',
      'Notes/huge.png': 'too-large'
    })
    expect(items.find(i => i.relativePath === 'Notes/img/logo.png')?.kind).toBe('image')
  })

  it('refuses an invalid path, a manifest with nothing to import, and a second active import', async () => {
    const alice = await createUser()
    await expect(createUploadImportJob(asUser(alice.id), personal, [{ path: '../../etc/passwd.md', size: 5 }]))
      .rejects.toMatchObject({ data: { code: 'import/path-invalid' } })
    await expect(createUploadImportJob(asUser(alice.id), personal, [{ path: 'a.exe', size: 5 }]))
      .rejects.toMatchObject({ data: { code: 'import/nothing-to-import' } })

    await createUploadImportJob(asUser(alice.id), personal, [{ path: 'a.md', size: 5 }])
    await expect(createUploadImportJob(asUser(alice.id), personal, [{ path: 'b.md', size: 5 }]))
      .rejects.toMatchObject({ data: { code: 'import/job-active' } })
  })

  it('enforces the plan caps: files and bytes per import, imports per day', async () => {
    const alice = await createUser()
    vi.stubEnv('TIER_FREE_IMPORT_FILES_PER_JOB', '2')
    vi.stubEnv('TIER_FREE_IMPORT_BYTES_PER_JOB', '1000')
    vi.stubEnv('TIER_FREE_IMPORT_JOBS_PER_DAY', '1')

    await expect(createUploadImportJob(asUser(alice.id), personal, ['a', 'b', 'c'].map(n => ({ path: `${n}.md`, size: 1 }))))
      .rejects.toMatchObject({ statusCode: 409, data: { code: 'plan/limit-reached', field: 'importFilesPerJob', limit: 2 } })
    await expect(createUploadImportJob(asUser(alice.id), personal, [{ path: 'a.md', size: 600 }, { path: 'b.md', size: 600 }]))
      .rejects.toMatchObject({ data: { code: 'plan/limit-reached', field: 'importBytesPerJob' } })

    await createUploadImportJob(asUser(alice.id), personal, [{ path: 'a.md', size: 10 }])
    await finishAll()
    await expect(createUploadImportJob(asUser(alice.id), personal, [{ path: 'a.md', size: 10 }]))
      .rejects.toMatchObject({ data: { code: 'plan/limit-reached', field: 'importJobsPerDay', limit: 1 } })
  })

  it('needs the editor role in a target workspace and a folder of that scope', async () => {
    const alice = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(alice.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    await createFolder(__mintWorkspaceAccess(__userActor(alice.id), ws.workspaceId, 'admin', 'editor'), { folderId: 'inbox', name: 'Inbox', parentId: null })
    await createFolder(asUser(alice.id), { folderId: 'mine', name: 'Mine', parentId: null })
    const files = [{ path: 'a.md', size: 5 }]

    await expect(createUploadImportJob(asUser(viewer.id), { workspaceId: ws.workspaceId, folderId: null }, files))
      .rejects.toMatchObject({ data: { code: 'workspace/role-required' } })
    await expect(createUploadImportJob(asUser(alice.id), { workspaceId: ws.workspaceId, folderId: 'mine' }, files))
      .rejects.toMatchObject({ data: { code: 'folder/not-found' } })

    const ok = await createUploadImportJob(asUser(alice.id), { workspaceId: ws.workspaceId, folderId: 'inbox' }, files)
    expect(await jobRow(ok.jobId)).toMatchObject({ workspace_id: ws.workspaceId, target_folder_id: 'inbox' })
  })
})

describe('createGithubImportJob', () => {
  beforeEach(resetDb)

  it('queues a job for a public repository link with its canonical URL', async () => {
    const alice = await createUser()
    const { jobId } = await createGithubImportJob(asUser(alice.id), personal, 'https://github.com/acme/handbook/tree/main/docs')
    const job = await jobRow(jobId)
    expect(job).toMatchObject({ status: 'queued', source: 'github', total: 0 })
    expect(job!.source_ref).toContain('github.com/acme/handbook')

    await expect(createGithubImportJob(asUser(alice.id), personal, 'https://github.com/acme/other'))
      .rejects.toMatchObject({ data: { code: 'import/job-active' } })
  })

  it('refuses a link that is not a GitHub repository before checking anything else', async () => {
    const alice = await createUser()
    await expect(createGithubImportJob(asUser(alice.id), personal, 'https://gitlab.com/acme/handbook'))
      .rejects.toMatchObject({ data: { code: 'import/github-url-invalid' } })
    expect((await testDb().query('SELECT 1 FROM import_jobs')).rows).toHaveLength(0)
  })
})
