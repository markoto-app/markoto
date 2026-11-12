import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  claimQueuedJob,
  countActiveJobs,
  enqueueExportJob,
  getJobById,
  getJobForUser,
  listAllJobsForUser,
  listJobsForUser,
  markExpiredJobs,
  markJobFailed,
  markJobReady
} from '../../server/repos/dataExportJobs'
import { createUser } from '../integration/setup/fixtures'
import { ConflictError, NotFoundError } from '../../server/repos/errors'
import { asUser, sys } from '../helpers/access'

describe('enqueueExportJob', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('inserts a queued row and returns the new job', async () => {
    const u = await createUser()
    const job = await enqueueExportJob(asUser(u.id))
    expect(job.userId).toBe(u.id)
    expect(job.status).toBe('queued')
    expect(job.jobId.length).toBeGreaterThan(10)
    expect(job.s3Key).toBeNull()
    expect(job.createdAt).toBeInstanceOf(Date)
  })

  it('throws ConflictError if a queued or running job already exists', async () => {
    const u = await createUser()
    await enqueueExportJob(asUser(u.id))
    await expect(enqueueExportJob(asUser(u.id))).rejects.toBeInstanceOf(ConflictError)
  })

  it('allows a fresh enqueue once the prior job is ready/failed/expired', async () => {
    const u = await createUser()
    const first = await enqueueExportJob(asUser(u.id))
    await markJobReady(sys(), { jobId: first.jobId, s3Key: 'k1', sizeBytes: 100, retentionDays: 7 })

    // Now a fresh enqueue is allowed.
    const second = await enqueueExportJob(asUser(u.id))
    expect(second.jobId).not.toBe(first.jobId)
    expect(second.status).toBe('queued')
  })
})

describe('claimQueuedJob', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns null when the queue is empty', async () => {
    expect(await claimQueuedJob(sys())).toBeNull()
  })

  it('claims the oldest queued row and flips it to running', async () => {
    const u1 = await createUser()
    const u2 = await createUser()
    const j1 = await enqueueExportJob(asUser(u1.id))
    // Force j2 to be slightly newer.
    await new Promise(r => setTimeout(r, 10))
    await enqueueExportJob(asUser(u2.id))

    const claimed = await claimQueuedJob(sys())
    expect(claimed).not.toBeNull()
    expect(claimed!.jobId).toBe(j1.jobId)
    expect(claimed!.status).toBe('running')
    expect(claimed!.startedAt).toBeInstanceOf(Date)
  })

  it('returns null when only running rows exist', async () => {
    const u = await createUser()
    await enqueueExportJob(asUser(u.id))
    await claimQueuedJob(sys()) // consume the only queued row

    expect(await claimQueuedJob(sys())).toBeNull()
  })
})

describe('markJobReady', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('flips to ready and sets s3Key, sizeBytes, completedAt, expiresAt', async () => {
    const u = await createUser()
    const job = await enqueueExportJob(asUser(u.id))
    await claimQueuedJob(sys()) // → running
    const before = Date.now()
    await markJobReady(sys(), { jobId: job.jobId, s3Key: 's3-key', sizeBytes: 12345, retentionDays: 7 })
    const after = Date.now()

    const reread = await getJobById(sys(), job.jobId)
    expect(reread.status).toBe('ready')
    expect(reread.s3Key).toBe('s3-key')
    expect(reread.sizeBytes).toBe(12345)
    expect(reread.completedAt).toBeInstanceOf(Date)

    // Expires 7 days out (allow ±5 min drift).
    const expectedExpiry = before + 7 * 24 * 60 * 60 * 1000
    expect(reread.expiresAt!.getTime()).toBeGreaterThanOrEqual(expectedExpiry - 5 * 60 * 1000)
    expect(reread.expiresAt!.getTime()).toBeLessThanOrEqual(after + 7 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000)
  })

  it('throws on out-of-range retentionDays', async () => {
    const u = await createUser()
    const job = await enqueueExportJob(asUser(u.id))
    await expect(markJobReady(sys(), { jobId: job.jobId, s3Key: 'k', sizeBytes: 1, retentionDays: 0 }))
      .rejects.toThrow(/out of range/)
    await expect(markJobReady(sys(), { jobId: job.jobId, s3Key: 'k', sizeBytes: 1, retentionDays: 91 }))
      .rejects.toThrow(/out of range/)
  })
})

describe('markJobFailed', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('flips to failed and stores the (truncated) error message', async () => {
    const u = await createUser()
    const job = await enqueueExportJob(asUser(u.id))
    const longMsg = 'x'.repeat(800)
    await markJobFailed(sys(), job.jobId, longMsg)

    const reread = await getJobById(sys(), job.jobId)
    expect(reread.status).toBe('failed')
    expect(reread.errorMessage).toBeTruthy()
    expect(reread.errorMessage!.length).toBeLessThanOrEqual(500)
    expect(reread.errorMessage!.endsWith('...')).toBe(true)
    expect(reread.completedAt).toBeInstanceOf(Date)
  })

  it('keeps short messages intact', async () => {
    const u = await createUser()
    const job = await enqueueExportJob(asUser(u.id))
    await markJobFailed(sys(), job.jobId, 'short error')
    const reread = await getJobById(sys(), job.jobId)
    expect(reread.errorMessage).toBe('short error')
  })
})

describe('markExpiredJobs', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('flips ready rows past expires_at to expired and returns their s3Keys', async () => {
    const u = await createUser()
    const job = await enqueueExportJob(asUser(u.id))
    await markJobReady(sys(), { jobId: job.jobId, s3Key: 'k1', sizeBytes: 1, retentionDays: 7 })
    // Backdate expires_at.
    await testDb().query(
      `UPDATE data_export_jobs SET expires_at = NOW() - INTERVAL '1 day' WHERE job_id = $1`,
      [job.jobId]
    )

    const flipped = await markExpiredJobs(sys())
    expect(flipped).toHaveLength(1)
    expect(flipped[0]).toEqual({ jobId: job.jobId, s3Key: 'k1' })

    const reread = await getJobById(sys(), job.jobId)
    expect(reread.status).toBe('expired')
  })

  it('does not flip rows whose expires_at is in the future', async () => {
    const u = await createUser()
    const job = await enqueueExportJob(asUser(u.id))
    await markJobReady(sys(), { jobId: job.jobId, s3Key: 'k1', sizeBytes: 1, retentionDays: 7 })

    expect(await markExpiredJobs(sys())).toEqual([])
    expect((await getJobById(sys(), job.jobId)).status).toBe('ready')
  })

  it('returns empty when no ready rows exist', async () => {
    expect(await markExpiredJobs(sys())).toEqual([])
  })
})

describe('listJobsForUser', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns jobs ordered most-recent-first, limited to 50', async () => {
    const u = await createUser()
    const j1 = await enqueueExportJob(asUser(u.id))
    await markJobReady(sys(), { jobId: j1.jobId, s3Key: 'k1', sizeBytes: 1, retentionDays: 7 })
    await new Promise(r => setTimeout(r, 10))
    const j2 = await enqueueExportJob(asUser(u.id))

    const list = await listJobsForUser(asUser(u.id))
    expect(list.map(j => j.jobId)).toEqual([j2.jobId, j1.jobId])
  })

  it('does not return another user\'s jobs', async () => {
    const u1 = await createUser()
    const u2 = await createUser()
    await enqueueExportJob(asUser(u1.id))
    expect(await listJobsForUser(asUser(u2.id))).toEqual([])
  })
})

describe('getJobForUser', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns the row for the rightful user', async () => {
    const u = await createUser()
    const job = await enqueueExportJob(asUser(u.id))
    const fetched = await getJobForUser(asUser(u.id), job.jobId)
    expect(fetched?.jobId).toBe(job.jobId)
  })

  it('returns null for a different user (no existence-leak)', async () => {
    const u1 = await createUser()
    const u2 = await createUser()
    const job = await enqueueExportJob(asUser(u1.id))
    expect(await getJobForUser(asUser(u2.id), job.jobId)).toBeNull()
  })

  it('returns null for a nonexistent jobId', async () => {
    const u = await createUser()
    expect(await getJobForUser(asUser(u.id), 'nope')).toBeNull()
  })
})

describe('countActiveJobs + listAllJobsForUser', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('counts queued + running rows across users', async () => {
    const u1 = await createUser()
    const u2 = await createUser()
    await enqueueExportJob(asUser(u1.id))
    await enqueueExportJob(asUser(u2.id))
    expect(await countActiveJobs(sys())).toBe(2)
  })

  it('listAllJobsForUser returns every row regardless of status', async () => {
    const u = await createUser()
    const j1 = await enqueueExportJob(asUser(u.id))
    await markJobReady(sys(), { jobId: j1.jobId, s3Key: 'k1', sizeBytes: 1, retentionDays: 7 })
    const j2 = await enqueueExportJob(asUser(u.id))

    const all = await listAllJobsForUser(asUser(u.id))
    expect(all.map(j => j.jobId).sort()).toEqual([j1.jobId, j2.jobId].sort())
  })
})

describe('getJobById', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('throws NotFoundError for unknown jobId', async () => {
    await expect(getJobById(sys(), 'nope')).rejects.toBeInstanceOf(NotFoundError)
  })
})
