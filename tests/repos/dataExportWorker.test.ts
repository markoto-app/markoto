import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetDb } from '../integration/setup/db'
import { createUser } from '../integration/setup/fixtures'
import { enqueueExportJob, getJobById } from '../../server/repos/dataExportJobs'

const s3SendMock = vi.fn(async () => ({}))
vi.mock('../../server/utils/storage/s3', () => ({
  useS3Client: () => ({ send: s3SendMock })
}))
vi.mock('../../server/utils/billing/stripeClient', () => ({
  useStripeClient: () => null
}))
// Email sender is already a no-throw stub in test mode (no provider
// env), but mock it explicitly so the test doesn't print log lines.
vi.mock('../../server/utils/email/sendEmail', () => ({
  safeSendTransactionalEmail: vi.fn(async () => ({ delivered: true }))
}))

// `useRuntimeConfig()` is a Nuxt auto-import in the running app but
// undefined in the repos test env. Stub it on globalThis so the
// worker's `config.s3.bucket` access works.
;(globalThis as { useRuntimeConfig?: () => Record<string, unknown> }).useRuntimeConfig = () => ({
  s3: { bucket: 'test-bucket' }
})

const { runDataExportWorker } = await import('../../server/utils/privacy/dataExportWorker')

describe('runDataExportWorker', () => {
  beforeEach(async () => {
    await resetDb()
    s3SendMock.mockClear()
    s3SendMock.mockImplementation(async () => ({}))
  })

  it('returns null fields when the queue is empty', async () => {
    const result = await runDataExportWorker()
    expect(result).toEqual({ jobId: null, succeeded: false, s3Key: null, errorMessage: null })
    expect(s3SendMock).not.toHaveBeenCalled()
  })

  it('claims a queued job, builds the ZIP, PUTs to S3, marks ready', async () => {
    const u = await createUser()
    const job = await enqueueExportJob(u.id)

    const result = await runDataExportWorker()
    expect(result.jobId).toBe(job.jobId)
    expect(result.succeeded).toBe(true)
    expect(result.s3Key).toBe(`exports/${u.id}/${job.jobId}.zip`)
    expect(s3SendMock).toHaveBeenCalledTimes(1)

    const reread = await getJobById(job.jobId)
    expect(reread.status).toBe('ready')
    expect(reread.s3Key).toBe(`exports/${u.id}/${job.jobId}.zip`)
    expect(reread.sizeBytes).toBeGreaterThan(0)
    expect(reread.expiresAt).toBeInstanceOf(Date)
    expect(reread.completedAt).toBeInstanceOf(Date)
  })

  it('marks the job failed when S3 PUT throws', async () => {
    const u = await createUser()
    const job = await enqueueExportJob(u.id)

    s3SendMock.mockRejectedValueOnce(new Error('s3 down'))

    const result = await runDataExportWorker()
    expect(result.succeeded).toBe(false)
    expect(result.errorMessage).toContain('s3 down')

    const reread = await getJobById(job.jobId)
    expect(reread.status).toBe('failed')
    expect(reread.errorMessage).toContain('s3 down')
  })

  it('processes one job per call (deterministic worker pacing)', async () => {
    const u1 = await createUser()
    const u2 = await createUser()
    await enqueueExportJob(u1.id)
    await enqueueExportJob(u2.id)

    const r1 = await runDataExportWorker()
    expect(r1.succeeded).toBe(true)
    const r2 = await runDataExportWorker()
    expect(r2.succeeded).toBe(true)
    // Different jobs.
    expect(r1.jobId).not.toBe(r2.jobId)
  })
})
