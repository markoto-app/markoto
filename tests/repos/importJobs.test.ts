import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser } from '../integration/setup/fixtures'
import {
  cancelImportJob,
  claimQueuedImportJob,
  createImportJob,
  deleteImportJobsBefore,
  finishImportJob,
  getImportJob,
  listImportItems,
  listImportJobsForExport,
  queueImportJob,
  requeueStaleImportJobs
} from '../../server/repos/imports'
import { asUser, sys } from '../helpers/access'

// Import job bookkeeping: one active import per user, workers claim
// different jobs, a job whose worker died is queued again, cancelling, and
// the user sees only their own jobs.

function newJob(jobId: string, status: 'uploading' | 'queued' = 'queued') {
  return {
    jobId,
    workspaceId: null,
    targetFolderId: null,
    source: 'upload' as const,
    sourceRef: null,
    status,
    total: 1,
    skipped: 1,
    totalBytes: 10,
    items: [
      { itemId: `${jobId}-a`, relativePath: 'docs/a.md', kind: 'doc' as const, s3Key: `imports/${jobId}/a`, sizeBytes: 10 },
      { itemId: `${jobId}-b`, relativePath: 'docs/b.exe', kind: 'doc' as const, s3Key: null, sizeBytes: 5, status: 'skipped' as const, reason: 'unsupported' as const }
    ]
  }
}

async function status(jobId: string): Promise<string | undefined> {
  return (await testDb().query<{ status: string }>('SELECT status FROM import_jobs WHERE job_id = $1', [jobId])).rows[0]?.status
}

describe('import jobs', () => {
  beforeEach(resetDb)

  it('allows one active job per user', async () => {
    const alice = await createUser()
    const bob = await createUser()
    expect(await createImportJob(asUser(alice.id), newJob('j1', 'uploading'))).not.toBeNull()
    expect(await createImportJob(asUser(alice.id), newJob('j2'))).toBeNull()
    expect(await createImportJob(asUser(bob.id), newJob('j3'))).not.toBeNull()
    await finishImportJob(sys(), 'j1', 'done')
    expect(await createImportJob(asUser(alice.id), newJob('j4'))).not.toBeNull()
  })

  it('refuses a concurrent second job for the same user', async () => {
    const alice = await createUser()
    const results = await Promise.all([1, 2, 3, 4].map(i => createImportJob(asUser(alice.id), newJob(`c${i}`))))
    expect(results.filter(r => r !== null)).toHaveLength(1)
  })

  it('a user reaches only their own jobs', async () => {
    const alice = await createUser()
    const bob = await createUser()
    await createImportJob(asUser(alice.id), newJob('j1', 'uploading'))
    expect(await getImportJob(asUser(bob.id), 'j1')).toBeNull()
    expect(await listImportItems(asUser(bob.id), 'j1', { problemsOnly: false, limit: 10 })).toEqual([])
    expect(await queueImportJob(asUser(bob.id), 'j1')).toBe(false)
    expect(await cancelImportJob(asUser(bob.id), 'j1')).toBeNull()
    expect(await status('j1')).toBe('uploading')
    expect((await listImportItems(asUser(alice.id), 'j1', { problemsOnly: true, limit: 10 })).map(i => i.relativePath)).toEqual(['docs/b.exe'])
    expect(await queueImportJob(asUser(alice.id), 'j1')).toBe(true)
    expect(await queueImportJob(asUser(alice.id), 'j1')).toBe(false)
  })

  it('claims the oldest queued job and skips one another worker holds', async () => {
    const alice = await createUser()
    const bob = await createUser()
    await createImportJob(asUser(alice.id), newJob('older'))
    await createImportJob(asUser(bob.id), newJob('newer'))
    await testDb().query(`UPDATE import_jobs SET created_at = now() - interval '1 minute' WHERE job_id = 'older'`)

    const holder = await testDb().connect()
    try {
      await holder.query('BEGIN')
      await holder.query(`SELECT id FROM import_jobs WHERE job_id = 'older' FOR UPDATE`)
      const claimed = await claimQueuedImportJob(sys())
      expect(claimed?.jobId).toBe('newer')
      expect(claimed?.status).toBe('running')
      expect(await claimQueuedImportJob(sys())).toBeNull()
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
    expect((await claimQueuedImportJob(sys()))?.jobId).toBe('older')
    expect(await claimQueuedImportJob(sys())).toBeNull()
  })

  it('queues a running job again when its heartbeat went stale', async () => {
    const alice = await createUser()
    const bob = await createUser()
    await createImportJob(asUser(alice.id), newJob('stale'))
    await createImportJob(asUser(bob.id), newJob('fresh'))
    await claimQueuedImportJob(sys())
    await claimQueuedImportJob(sys())
    await testDb().query(`UPDATE import_jobs SET heartbeat_at = now() - interval '10 minutes' WHERE job_id = 'stale'`)
    expect(await requeueStaleImportJobs(sys(), new Date(Date.now() - 2 * 60_000))).toBe(1)
    expect(await status('stale')).toBe('queued')
    expect(await status('fresh')).toBe('running')
  })

  it('cancels a waiting job at once and flags a running one', async () => {
    const alice = await createUser()
    const bob = await createUser()
    await createImportJob(asUser(alice.id), newJob('waiting', 'uploading'))
    expect(await cancelImportJob(asUser(alice.id), 'waiting')).toBe('cancelled')
    await createImportJob(asUser(bob.id), newJob('running'))
    await claimQueuedImportJob(sys())
    expect(await cancelImportJob(asUser(bob.id), 'running')).toBe('running')
    const row = (await testDb().query<{ cancel_requested: boolean }>(`SELECT cancel_requested FROM import_jobs WHERE job_id = 'running'`)).rows[0]
    expect(row?.cancel_requested).toBe(true)
    // A finished job stays as it is.
    expect(await cancelImportJob(asUser(alice.id), 'waiting')).toBe('cancelled')
  })

  it('deletes finished jobs past retention with their items, and exports names and outcomes only', async () => {
    const alice = await createUser()
    await createImportJob(asUser(alice.id), newJob('old'))
    await finishImportJob(sys(), 'old', 'done')
    const exported = await listImportJobsForExport(asUser(alice.id))
    expect(exported).toHaveLength(1)
    expect(exported[0]?.items.map(i => [i.relativePath, i.status])).toEqual([['docs/a.md', 'pending'], ['docs/b.exe', 'skipped']])
    await testDb().query(`UPDATE import_jobs SET finished_at = now() - interval '31 days' WHERE job_id = 'old'`)
    expect(await deleteImportJobsBefore(sys(), new Date(Date.now() - 30 * 86_400_000))).toBe(1)
    expect((await testDb().query('SELECT 1 FROM import_job_items')).rowCount).toBe(0)
  })
})
