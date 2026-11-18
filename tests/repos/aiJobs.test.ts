import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createDoc } from '../integration/setup/fixtures'
import { asUser, docAs, sys } from '../helpers/access'
import {
  addAiJobProgress,
  claimAiJobUnits,
  countAiJobsSince,
  createAiJob,
  deleteOldAiJobs,
  getAiJob,
  getAiJobForDoc,
  listAiJobUnits,
  listAiJobsForUser,
  markStaleAiJobsInterrupted,
  purgeAiJobBeforeTexts,
  requeueAiJobUnits,
  requeueRunningAiJobUnits,
  transitionAiJob,
  updateAiJobUnit,
  type NewAiJobUnit
} from '../../server/repos/aiJobs'
import { appendActivity, listRecentActivity } from '../../server/repos/activity'

// `ai_jobs` / `ai_job_units`: create with units in one transaction, the
// runner's claim (no unit claimed twice), counters, status transitions,
// the sweeper's interrupt + purge + retention, and the cascades.

function units(n: number): NewAiJobUnit[] {
  return Array.from({ length: n }, (_, i) => ({
    ordinal: i,
    headingPath: `S ${i}`,
    startRel: `start-${i}`,
    endRel: `end-${i}`,
    revBefore: `rev${i}`,
    unitTokens: 100,
    beforeText: `before ${i}`
  }))
}

async function seed(n = 5, status: 'preview' | 'running' = 'running') {
  const user = await createUser()
  const doc = await createDoc({ ownerId: user.id })
  const proof = docAs(doc.docId, user.id)
  const job = await createAiJob(proof, {
    id: `j-${doc.docId}`,
    workspaceId: null,
    sessionId: 's1',
    mode: 'rewrite',
    status,
    params: { instruction: 'Formal.' },
    estimate: { units: n, inputTokens: 1, outputTokens: 1, usd: 0.01, minutes: 1 },
    workerModel: 'markoto-worker',
    costKnown: true
  }, units(n))
  return { user, doc, proof, job }
}

describe('aiJobs repo', () => {
  beforeEach(resetDb)

  it('creates a job with its units for the proof user and document', async () => {
    const { user, doc, proof, job } = await seed(3)
    expect(job).toMatchObject({ docId: doc.docId, initiatorUserId: user.id, unitsTotal: 3, status: 'running' })
    expect(job.heartbeatAt).not.toBeNull()
    expect(await getAiJobForDoc(proof, job.id)).toMatchObject({ id: job.id })
    const other = await createDoc({ ownerId: user.id })
    expect(await getAiJobForDoc(docAs(other.docId, user.id), job.id)).toBeNull()
    expect((await listAiJobUnits(sys(), job.id)).map(u => u.status)).toEqual(['pending', 'pending', 'pending'])
    expect(await listAiJobsForUser(asUser(user.id))).toHaveLength(1)
  })

  it('claims each pending unit once, lowest ordinal first, also under concurrency', async () => {
    const { job } = await seed(10)
    const [a, b, c] = await Promise.all([claimAiJobUnits(sys(), job.id, 4), claimAiJobUnits(sys(), job.id, 4), claimAiJobUnits(sys(), job.id, 4)])
    const all = [...a!, ...b!, ...c!].map(u => u.ordinal).sort((x, y) => x - y)
    expect(all).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(await claimAiJobUnits(sys(), job.id, 4)).toEqual([])
    expect(await requeueRunningAiJobUnits(sys(), job.id)).toBe(10)
  })

  it('updates units and counters and transitions only from the given statuses', async () => {
    const { job } = await seed(2)
    await updateAiJobUnit(sys(), job.id, 0, { status: 'applied', afterHash: 'h', costUsd: 0.002, output: { kind: 'scan', items: [{ text: 'x' }] } })
    const row = await addAiJobProgress(sys(), job.id, { done: 1, costUsd: 0.002, tokensIn: 10, tokensOut: 5 })
    expect(row).toMatchObject({ unitsDone: 1, tokensIn: 10, tokensOut: 5 })
    expect(row!.costUsd).toBeCloseTo(0.002, 6)
    expect((await listAiJobUnits(sys(), job.id, ['applied']))[0]).toMatchObject({ afterHash: 'h', output: { kind: 'scan', items: [{ text: 'x' }] } })
    expect(await transitionAiJob(sys(), job.id, ['preview'], 'cancelled')).toBe(false)
    expect(await transitionAiJob(sys(), job.id, ['running'], 'cancelled')).toBe(true)
    expect((await getAiJob(sys(), job.id))!.status).toBe('cancelled')
    await updateAiJobUnit(sys(), job.id, 1, { status: 'skipped', reason: 'x' })
    expect(await requeueAiJobUnits(sys(), job.id, [1])).toBe(1)
    expect((await listAiJobUnits(sys(), job.id, ['pending'])).map(u => u.reason)).toEqual([null])
  })

  it('counts started jobs per user per day, not previews', async () => {
    const { user } = await seed(1, 'running')
    await seed(1, 'preview')
    expect(await countAiJobsSince(asUser(user.id), new Date(Date.now() - 86_400_000))).toBe(1)
  })

  it('sweeper: interrupts stale running jobs and requeues their units', async () => {
    const { job } = await seed(3)
    await claimAiJobUnits(sys(), job.id, 2)
    await testDb().query(`UPDATE ai_jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [job.id])
    const fresh = await seed(1)
    expect(await markStaleAiJobsInterrupted(sys(), new Date(Date.now() - 120_000))).toEqual([job.id])
    expect((await getAiJob(sys(), job.id))!.status).toBe('interrupted')
    expect((await getAiJob(sys(), fresh.job.id))!.status).toBe('running')
    expect((await listAiJobUnits(sys(), job.id)).every(u => u.status === 'pending')).toBe(true)
  })

  it('sweeper: purges before texts after the undo window and deletes old jobs', async () => {
    const { job } = await seed(2)
    const recent = await seed(1)
    await testDb().query(`UPDATE ai_jobs SET created_at = now() - interval '8 days', status = 'done' WHERE id = $1`, [job.id])
    expect(await purgeAiJobBeforeTexts(sys(), new Date(Date.now() - 7 * 86_400_000))).toBe(2)
    expect((await listAiJobUnits(sys(), job.id)).every(u => u.beforeText === null)).toBe(true)
    expect((await listAiJobUnits(sys(), recent.job.id))[0]!.beforeText).toBe('before 0')
    await testDb().query(`UPDATE ai_jobs SET created_at = now() - interval '91 days' WHERE id = $1`, [job.id])
    expect(await deleteOldAiJobs(sys(), new Date(Date.now() - 90 * 86_400_000))).toBe(1)
    expect(await getAiJob(sys(), job.id)).toBeNull()
    const leftUnits = await testDb().query('SELECT count(*)::int AS n FROM ai_job_units WHERE job_id = $1', [job.id])
    expect(leftUnits.rows[0].n).toBe(0)
  })

  it('attributes ai-job principal rows to the initiator', async () => {
    const { user, proof, job } = await seed(1)
    await appendActivity(proof, {
      userId: user.id,
      userName: null,
      actorPrincipal: `ai-job:${job.id}`,
      action: 'ai.job',
      metadata: { kind: 'ai.job', jobId: job.id, mode: 'rewrite', phase: 'started', status: 'running', unitsTotal: 1, done: 0, skipped: 0, flagged: 0 }
    })
    const [row] = await listRecentActivity(proof)
    expect(row).toMatchObject({ action: 'ai.job', agentKind: 'ai', agentInitiatorUserId: user.id, agentInitiatorName: user.name })
  })

  it('cascades with the document and with the initiator', async () => {
    const a = await seed(1)
    // An editor (not the owner) starts a job on the owner's document, then deletes their account.
    const editor = await createUser()
    const b = await createAiJob(docAs(a.doc.docId, editor.id), {
      id: 'j-editor', workspaceId: null, sessionId: null, mode: 'translate', status: 'preview',
      params: { instruction: 'x' }, estimate: null, workerModel: null, costKnown: false
    }, units(1))
    await testDb().query('DELETE FROM users WHERE id = $1', [editor.id])
    expect(await getAiJob(sys(), b.id)).toBeNull()
    expect(await getAiJob(sys(), a.job.id)).not.toBeNull()
    await testDb().query('DELETE FROM documents WHERE doc_id = $1', [a.doc.docId])
    expect(await getAiJob(sys(), a.job.id)).toBeNull()
  })
})
