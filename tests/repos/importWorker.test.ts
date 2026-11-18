import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'
import { PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { resetDb, testDb, readYjsRows } from '../integration/setup/db'
import { createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import { stubEnv } from '../helpers/env'
import { startFakeGithub, type FakeGithub } from '../helpers/fakeGithub'
import { createImportJob, getImportJobForWorker, type NewImportItem } from '../../server/repos/imports'
import { asUser, sys } from '../helpers/access'

// The import worker against the real test stack: Postgres, SeaweedFS and
// the markitdown container. `processImportJob` is called directly on a job
// this test put into `running` (the app's sweeper would pick it up only
// every 15 s). GitHub is a local fake reached through the test-mode origin
// seam. Nitro auto-imports the worker relies on are stubbed with their real
// implementations (or a no-op for trace headers). The S3 client is this
// file's own, with the test stack's keys: the app's singleton may already
// have been built by an earlier file (repos files share one process) under
// other settings, and another file may have stubbed the auto-import.

const s3 = new S3Client({
  endpoint: 'http://127.0.0.1:8334',
  region: 'us-east-1',
  credentials: { accessKeyId: 'ypad-access-key', secretAccessKey: 'ypad-secret-key' },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
})
function stubAutoImports() {
  vi.stubGlobal('useS3Client', () => s3)
  vi.stubGlobal('injectTraceHeaders', (h: Record<string, string>) => h)
}
stubAutoImports()

const { processImportJob } = await import('../../server/utils/imports/importWorker')

const BUCKET = 'ypad'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

function testStorageEnv(extra: Record<string, string | undefined> = {}) {
  stubEnv({
    NUXT_S3_ENDPOINT: 'http://127.0.0.1:8334',
    NUXT_S3_ACCESS_KEY: 'ypad-access-key',
    NUXT_S3_SECRET_KEY: 'ypad-secret-key',
    NUXT_S3_BUCKET: BUCKET,
    NUXT_MARKITDOWN_URL: 'http://127.0.0.1:8081',
    NUXT_MARKITDOWN_API_SECRET: 'test-markitdown-api-secret-isolated',
    ...extra
  })
}

async function put(key: string, body: Uint8Array): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }))
}

async function exists(key: string): Promise<boolean> {
  try {
    await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

let seq = 0

/** An uploaded file: put to its staging key like the browser would. */
async function uploaded(jobId: string, relativePath: string, body: Uint8Array, kind: NewImportItem['kind'] = 'doc'): Promise<NewImportItem> {
  const itemId = `it${++seq}`
  const s3Key = `imports/${jobId}/${itemId}`
  await put(s3Key, body)
  return { itemId, relativePath, kind, s3Key, sizeBytes: body.byteLength }
}

/** Create the job and run it to its end as the worker would. */
async function runJob(userId: number, input: { jobId: string, workspaceId?: string | null, source?: 'upload' | 'github', sourceRef?: string | null, items: NewImportItem[], cancel?: boolean }) {
  const created = await createImportJob(asUser(userId), {
    jobId: input.jobId,
    workspaceId: input.workspaceId ?? null,
    targetFolderId: null,
    source: input.source ?? 'upload',
    sourceRef: input.sourceRef ?? null,
    status: 'queued',
    total: input.items.length,
    skipped: 0,
    totalBytes: input.items.reduce((n, i) => n + i.sizeBytes, 0),
    items: input.items
  })
  if (!created) throw new Error('job refused')
  await testDb().query(`UPDATE import_jobs SET status = 'running', cancel_requested = $2, started_at = now(), heartbeat_at = now() WHERE job_id = $1`, [input.jobId, input.cancel === true])
  const job = await getImportJobForWorker(sys(), input.jobId)
  if (!job) throw new Error('job vanished')
  await processImportJob(job)
  return (await getImportJobForWorker(sys(), input.jobId))!
}

async function items(jobId: string) {
  return (await testDb().query<{ relative_path: string, status: string, reason: string | null, doc_id: string | null, images_skipped: number }>(
    'SELECT relative_path, status, reason, doc_id, images_skipped FROM import_job_items WHERE job_id = $1 ORDER BY relative_path', [jobId]
  )).rows
}

async function docOf(jobId: string, path: string) {
  const item = (await items(jobId)).find(i => i.relative_path === path)
  if (!item?.doc_id) throw new Error(`no document for ${path}`)
  const row = (await testDb().query<{ doc_id: string, title: string, folder_id: string | null, owner_id: number | null, workspace_id: string | null }>(
    'SELECT doc_id, title, folder_id, owner_id, workspace_id FROM documents WHERE doc_id = $1', [item.doc_id]
  )).rows[0]!
  const search = (await testDb().query<{ body: string }>('SELECT body FROM document_search WHERE doc_id = $1', [item.doc_id])).rows[0]
  return { ...row, body: search?.body ?? null, yjsRows: (await readYjsRows(item.doc_id)).length }
}

async function folderNames(folderId: string | null): Promise<string[]> {
  const names: string[] = []
  let id = folderId
  while (id) {
    const row = (await testDb().query<{ name: string, parent_id: string | null }>('SELECT name, parent_id FROM folders WHERE folder_id = $1', [id])).rows[0]
    if (!row) break
    names.unshift(row.name)
    id = row.parent_id
  }
  return names
}

/** A one-paragraph DOCX with an embedded PNG (the parts Word itself needs, nothing more). */
function docxWithImage(text: string): Uint8Array {
  const files: Zippable = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>'),
    'word/media/image1.png': new Uint8Array(PNG),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
<w:p><w:r><w:t>${text}</w:t></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="95250" cy="95250"/><wp:docPr id="1" name="Picture 1" descr="a dot"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
</w:body>
</w:document>`)
  }
  return zipSync(files)
}

describe('import worker', () => {
  beforeEach(async () => {
    await resetDb()
    testStorageEnv()
    stubAutoImports()
  })

  it('imports a folder of Markdown: folders mirrored, relative image stored, cross links rewritten, text indexed', async () => {
    const alice = await createUser()
    const jobId = 'md-folder'
    const job = await runJob(alice.id, {
      jobId,
      items: [
        await uploaded(jobId, 'Handbook/intro.md', strToU8('# Welcome\n\nSee [the guide](guide/setup.md#install) and ![dot](img/dot.png).\n\nOutside: [site](https://example.com).\n')),
        await uploaded(jobId, 'Handbook/guide/setup.md', strToU8('---\nmarkoto: 1\ntitle: Setup steps\n---\nBack to [intro](../intro.md). Install with `bun`.\n')),
        await uploaded(jobId, 'Handbook/img/dot.png', new Uint8Array(PNG), 'image'),
        await uploaded(jobId, 'Handbook/notes.md', new Uint8Array([0xff, 0xfe, 0x00, 0x41]))
      ]
    })
    expect(job).toMatchObject({ status: 'done', total: 3, done: 2, failed: 1 })

    const intro = await docOf(jobId, 'Handbook/intro.md')
    const setup = await docOf(jobId, 'Handbook/guide/setup.md')
    expect(intro).toMatchObject({ title: 'Welcome', owner_id: alice.id, workspace_id: null })
    expect(setup.title).toBe('Setup steps')
    expect(await folderNames(intro.folder_id)).toEqual(['Handbook'])
    expect(await folderNames(setup.folder_id)).toEqual(['Handbook', 'guide'])

    expect(intro.body).toContain(`[the guide](/d/${setup.doc_id}#install)`)
    expect(intro.body).toContain('(https://example.com)')
    expect(intro.body).toMatch(new RegExp(`!\\[dot\\]\\(/api/files/${intro.doc_id}/[A-Za-z0-9_-]+\\.png\\)`))
    expect(setup.body).toContain(`[intro](/d/${intro.doc_id})`)
    expect(intro.yjsRows).toBe(1)

    const upload = (await testDb().query<{ s3_key: string, confirmed: boolean }>('SELECT s3_key, confirmed_at IS NOT NULL AS confirmed FROM uploads WHERE doc_id = $1', [intro.doc_id])).rows
    expect(upload).toHaveLength(1)
    expect(upload[0]?.confirmed).toBe(true)
    expect(await exists(upload[0]!.s3_key)).toBe(true)

    const all = await items(jobId)
    expect(all.find(i => i.relative_path === 'Handbook/notes.md')).toMatchObject({ status: 'failed', reason: 'not-utf8' })
    expect(all.find(i => i.relative_path === 'Handbook/img/dot.png')?.status).toBe('done')
    // Staging files are gone once the job ended.
    expect(await exists(`imports/${jobId}/it1`)).toBe(false)
    const audit = (await testDb().query<{ action: string }>(`SELECT action FROM audit_log WHERE action = 'import.completed'`)).rows
    expect(audit).toHaveLength(1)
  })

  it('converts a DOCX through markitdown and stores its embedded picture', async () => {
    const alice = await createUser()
    const jobId = 'docx'
    const job = await runJob(alice.id, { jobId, items: [await uploaded(jobId, 'report.docx', docxWithImage('Quarterly report body'))] })
    expect(job).toMatchObject({ status: 'done', done: 1, failed: 0 })
    const doc = await docOf(jobId, 'report.docx')
    expect(doc.title).toBe('report')
    expect(doc.body).toContain('Quarterly report body')
    expect(doc.body).not.toContain('data:image')
    expect(doc.body).toMatch(new RegExp(`/api/files/${doc.doc_id}/[A-Za-z0-9_-]+\\.png`))
    expect((await items(jobId))[0]?.images_skipped).toBe(0)
  })

  it('expands an uploaded zip into a folder named after it', async () => {
    const alice = await createUser()
    const jobId = 'zip'
    const zip = zipSync({
      'a.md': strToU8('# A\n\n[b](sub/b.md)\n'),
      'sub/b.md': strToU8('# B\n'),
      '../evil.md': strToU8('# Evil\n'),
      '__MACOSX/a.md': strToU8('junk'),
      'tool.exe': strToU8('MZ')
    })
    const job = await runJob(alice.id, { jobId, items: [await uploaded(jobId, 'export.zip', zip, 'archive')] })
    expect(job).toMatchObject({ status: 'done', total: 2, done: 2, failed: 0 })
    const a = await docOf(jobId, 'export/a.md')
    const b = await docOf(jobId, 'export/sub/b.md')
    expect(await folderNames(a.folder_id)).toEqual(['export'])
    expect(await folderNames(b.folder_id)).toEqual(['export', 'sub'])
    expect(a.body).toContain(`/d/${b.doc_id}`)
    expect((await items(jobId)).map(i => i.relative_path)).not.toContain('evil.md')
  })

  it('refuses a zip bomb as one failed file', async () => {
    const alice = await createUser()
    const jobId = 'bomb'
    const bomb = zipSync({ 'huge.md': new Uint8Array(20 * 1024 * 1024) }, { level: 9 })
    expect(bomb.byteLength).toBeLessThan(200 * 1024)
    const job = await runJob(alice.id, {
      jobId,
      items: [await uploaded(jobId, 'bomb.zip', bomb, 'archive'), await uploaded(jobId, 'ok.md', strToU8('# Fine\n'))]
    })
    expect(job.status).toBe('done')
    const all = await items(jobId)
    expect(all.find(i => i.relative_path === 'bomb.zip')).toMatchObject({ status: 'failed', reason: 'unreadable' })
    expect(all.find(i => i.relative_path === 'ok.md')?.status).toBe('done')
    expect(all.some(i => i.relative_path.includes('huge'))).toBe(false)
  })

  it('stops at the first file when cancelled; nothing is created', async () => {
    const alice = await createUser()
    const jobId = 'cancel'
    const job = await runJob(alice.id, { jobId, cancel: true, items: [await uploaded(jobId, 'a.md', strToU8('# A\n'))] })
    expect(job.status).toBe('cancelled')
    expect(await items(jobId)).toMatchObject([{ status: 'skipped', reason: 'cancelled', doc_id: null }])
    expect((await testDb().query('SELECT 1 FROM documents')).rowCount).toBe(0)
  })

  it('fails a workspace import whose importer is no longer an editor', async () => {
    const owner = await createUser()
    const bob = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, bob.id, 'viewer')
    const jobId = 'lost'
    const job = await runJob(bob.id, { jobId, workspaceId: ws.workspaceId, items: [await uploaded(jobId, 'a.md', strToU8('# A\n'))] })
    expect(job).toMatchObject({ status: 'failed', error: 'access-lost' })
    expect((await testDb().query('SELECT 1 FROM documents')).rowCount).toBe(0)
  })

  it('files a workspace import into the workspace', async () => {
    const owner = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const jobId = 'ws'
    await runJob(editor.id, { jobId, workspaceId: ws.workspaceId, items: [await uploaded(jobId, 'Team/a.md', strToU8('# A\n'))] })
    const doc = await docOf(jobId, 'Team/a.md')
    expect(doc).toMatchObject({ owner_id: editor.id, workspace_id: ws.workspaceId })
    const folder = (await testDb().query<{ workspace_id: string | null, owner_id: number | null }>('SELECT workspace_id, owner_id FROM folders WHERE folder_id = $1', [doc.folder_id])).rows[0]
    expect(folder).toEqual({ workspace_id: ws.workspaceId, owner_id: null })
  })
})

describe('import worker: GitHub', () => {
  let gh: FakeGithub
  let origin = ''
  const files: Record<string, Uint8Array> = {
    'README.md': strToU8('# Readme\n\nSee [guide](docs/guide.md).\n'),
    'docs/guide.md': strToU8('# Guide\n\n![logo](../assets/logo.png)\n'),
    'assets/logo.png': new Uint8Array(PNG),
    'src/index.ts': strToU8('export {}')
  }
  // A repository far larger than one import may bring in, with a small folder.
  const big: Record<string, Uint8Array> = { 'content/docs/ai/intro.md': strToU8('# Intro\n') }
  for (let i = 0; i < 30; i++) big[`vendor/blob-${i}.png`] = new Uint8Array(9 * 1024 * 1024)

  beforeAll(async () => {
    gh = await startFakeGithub([
      { owner: 'acme', repo: 'docs', defaultBranch: 'main', files },
      { owner: 'acme', repo: 'big', defaultBranch: 'main', files: big }
    ])
    origin = gh.origin
  })

  afterAll(async () => {
    await gh.close()
  })

  beforeEach(async () => {
    await resetDb()
    testStorageEnv({ TEST_GITHUB_IMPORT_ORIGIN: origin })
    stubAutoImports()
    gh.requests.length = 0
  })

  it('imports a folder of a large repository: only that folder is listed and downloaded', async () => {
    const alice = await createUser()
    const job = await runJob(alice.id, { jobId: 'gh-big', source: 'github', sourceRef: 'https://github.com/acme/big/tree/main/content/docs/ai', items: [] })
    expect(job).toMatchObject({ status: 'done', total: 1, done: 1 })
    expect(gh.requests).toEqual(['/api/repos/acme/big/git/trees/main:content/docs/ai', '/raw/acme/big/main/content/docs/ai/intro.md'])
    expect((await items('gh-big')).map(i => i.relative_path)).toEqual(['ai/intro.md'])
  })

  it('refuses a whole repository above the archive cap before downloading any file', async () => {
    const alice = await createUser()
    const job = await runJob(alice.id, { jobId: 'gh-huge', source: 'github', sourceRef: 'https://github.com/acme/big', items: [] })
    expect(job).toMatchObject({ status: 'failed', error: 'archive-too-large' })
    expect(gh.requests.filter(r => r.startsWith('/raw/'))).toEqual([])
  })

  it('imports a repository from the default branch with images and links', async () => {
    const alice = await createUser()
    const job = await runJob(alice.id, { jobId: 'gh', source: 'github', sourceRef: 'https://github.com/acme/docs', items: [] })
    expect(job).toMatchObject({ status: 'done', total: 2, done: 2, failed: 0 })
    expect(gh.requests.slice(0, 2)).toEqual(['/api/repos/acme/docs', '/api/repos/acme/docs/git/trees/main'])
    // Only importable files are downloaded (not src/index.ts).
    expect(gh.requests.slice(2).toSorted()).toEqual(['/raw/acme/docs/main/README.md', '/raw/acme/docs/main/assets/logo.png', '/raw/acme/docs/main/docs/guide.md'])
    // The repository lands in a folder named after it, like an uploaded folder.
    const readme = await docOf('gh', 'docs/README.md')
    const guide = await docOf('gh', 'docs/docs/guide.md')
    expect(await folderNames(readme.folder_id)).toEqual(['docs'])
    expect(await folderNames(guide.folder_id)).toEqual(['docs', 'docs'])
    expect(readme.body).toContain(`(/d/${guide.doc_id})`)
    expect(guide.body).toMatch(new RegExp(`/api/files/${guide.doc_id}/[A-Za-z0-9_-]+\\.png`))
  })

  it('imports only a folder of a repository at a given ref', async () => {
    const alice = await createUser()
    const job = await runJob(alice.id, { jobId: 'gh-sub', source: 'github', sourceRef: 'https://github.com/acme/docs/tree/main/docs', items: [] })
    expect(job).toMatchObject({ status: 'done', total: 1, done: 1 })
    expect(gh.requests).toEqual(['/api/repos/acme/docs/git/trees/main:docs', '/raw/acme/docs/main/docs/guide.md'])
    expect((await items('gh-sub')).map(i => i.relative_path)).toEqual(['docs/guide.md'])
  })

  it('fails the job when the repository does not exist', async () => {
    const alice = await createUser()
    const job = await runJob(alice.id, { jobId: 'gh-404', source: 'github', sourceRef: 'https://github.com/acme/missing', items: [] })
    expect(job).toMatchObject({ status: 'failed', error: 'github-not-found' })
  })
})
