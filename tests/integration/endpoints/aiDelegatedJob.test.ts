import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createDoc } from '../setup/fixtures'
import { fakeOpenAiBaseUrl } from '../setup/env'
import { byokUser, connectSync, resetFake, uniqueKey, waitFor, writeDocAs, type SyncClient } from '../setup/byok'

// A delegated translation end to end, through the real prompt route, loop,
// job engine, LiteLLM and sync server: the `obedient-chat` fake planner
// reads the document and follows the FAKE_DIRECTIVE line in it, which calls
// delegate_rewrite with action "start" on section 2; the fake answers the
// job's worker calls with English filler that keeps headings and
// placeholders (tests/fixtures/fake-openai/server.py). Checks the document
// changed (code untouched), the `ai.job` activity row, the job routes'
// initiator-only rule, and that Undo job restores the German text.

const FAKE = fakeOpenAiBaseUrl()
const CODE = '```bash\nmarkoto sync --all\n```'

const syncClients: SyncClient[] = []
afterEach(() => {
  for (const c of syncClients.splice(0)) c.destroy()
})

function directive(action: 'start' | 'preview' = 'start'): string {
  const args = { targets: ['2 Installation'], mode: 'translate', target_language: 'English', instruction: 'Translate faithfully.', ...(action === 'start' ? { action: 'start' } : {}) }
  return `FAKE_DIRECTIVE delegate_rewrite ${JSON.stringify(args)}`
}

const SECTION_2 = `# 2 Installation\n\nDie Installation dauert nur wenige Minuten und ist einfach.\n\n${CODE}\n\nDanach sind alle Notizen auf deinem Gerät verfügbar.\n`

async function readDoc(docId: string, userId: number): Promise<string> {
  const c = connectSync(docId, { userId: String(userId), userName: 'Reader' })
  syncClients.push(c)
  await c.synced
  return c.doc.getText('content').toString()
}

describe('delegated AI job (delegate_rewrite) end to end', () => {
  beforeEach(async () => {
    await resetDb()
    await resetFake()
  })

  it('translates a section in the background, logs it, and Undo job restores it', async () => {
    const alice = await byokUser('Alice')
    const client = await loggedInClient(alice.id, 'Alice')
    const put = await client.put('/api/user/ai-providers/chat', { baseUrl: FAKE, model: 'obedient-chat', apiKey: uniqueKey('job'), supportsVision: false })
    expect(put.status).toBe(200)
    const doc = await createDoc({ ownerId: alice.id, title: 'Teamhandbuch' })
    const original = `# 1 Einleitung\n\nDieses Handbuch ist für das Team.\n${directive()}\n\n${SECTION_2}`
    syncClients.push(await writeDocAs(doc.docId, { userId: String(alice.id), userName: 'Alice' }, original))

    const res = await client.post('/api/ai/prompt', { docId: doc.docId, prompt: 'Translate section 2 into English.' })
    expect(res.status).toBe(200)

    // The job appears in the caller's list and finishes.
    const job = await waitFor(async () => {
      const list = await client.get(`/api/docs/${doc.docId}/ai-jobs`)
      if (list.status !== 200) return null
      const { jobs }: { jobs: Array<{ jobId: string, status: string, done: number, total: number }> } = await list.json()
      return jobs[0]?.status === 'done' ? jobs[0] : null
    }, 90_000, 'the delegated job to finish')
    expect(job.done).toBe(job.total)

    const translated = await waitFor(async () => {
      const text = await readDoc(doc.docId, alice.id)
      return text.includes('Translated heading') ? text : null
    }, 20_000, 'the translation to reach the document')
    expect(translated).toContain('# 1 Einleitung')
    expect(translated).toContain(CODE)
    expect(translated).not.toContain('Die Installation dauert')
    // The old heading anchor is pinned so links to it keep working.
    expect(translated).toMatch(/^# Translated heading \{#[^}]+\}$/m)

    // Progress is the initiator's: a user without edit rights is refused by
    // the route (403); another editor would get 404 (initiator-only read).
    const bob = await byokUser('Bob')
    const bobClient = await loggedInClient(bob.id, 'Bob')
    expect((await bobClient.get(`/api/docs/${doc.docId}/ai-jobs/${job.jobId}`)).status).toBe(403)
    const mine = await client.get(`/api/docs/${doc.docId}/ai-jobs/${job.jobId}`)
    expect(mine.status).toBe(200)

    // One finished `ai.job` row.
    const rows = await waitFor(async () => {
      const r = await client.get(`/api/docs/${doc.docId}/activity`)
      const list: Array<{ action: string, metadata: { phase?: string, jobId?: string } | null }> = await r.json()
      return list.some(a => a.action === 'ai.job' && a.metadata?.phase === 'finished') ? list : null
    }, 15_000, 'the ai.job activity row')
    expect(rows.find(a => a.action === 'ai.job' && a.metadata?.phase === 'finished')?.metadata?.jobId).toBe(job.jobId)

    // Undo job restores the German text and logs it.
    const revert = await client.post(`/api/docs/${doc.docId}/ai-jobs/${job.jobId}/revert`, {})
    expect(revert.status).toBe(200)
    expect(await revert.json()).toEqual({ reverted: 1, skipped: 0 })
    await waitFor(async () => ((await readDoc(doc.docId, alice.id)).includes('Die Installation dauert') ? true : null), 15_000, 'the German text to come back')
    expect(await readDoc(doc.docId, alice.id)).toBe(original)
  }, 180_000)

  it('shows the running job in awareness after a preview (preview, then start)', async () => {
    // The planner previews first, then starts: both check out the job's
    // pooled connection, and the preview clears its presence on close.
    // The run must announce itself again, or the initiator's prompt bar
    // never notices the job (it reloads its jobs when awareness shows one).
    const alice = await byokUser('Alice')
    const client = await loggedInClient(alice.id, 'Alice')
    const put = await client.put('/api/user/ai-providers/chat', { baseUrl: FAKE, model: 'obedient-chat', apiKey: uniqueKey('job2'), supportsVision: false })
    expect(put.status).toBe(200)
    const doc = await createDoc({ ownerId: alice.id, title: 'Teamhandbuch' })
    const original = `# 1 Einleitung\n\nDieses Handbuch ist für das Team.\n${directive('preview')}\n\n${SECTION_2}`
    syncClients.push(await writeDocAs(doc.docId, { userId: String(alice.id), userName: 'Alice' }, original))

    // A second client of Alice's counts how often a job presence appears
    // (absent, then present again; a reappearing client may arrive as an
    // update of a known client id).
    const observer = connectSync(doc.docId, { userId: String(alice.id), userName: 'Alice' })
    syncClients.push(observer)
    await observer.synced
    const appearances = new Map<string, number>()
    const present = new Set<number>()
    observer.awareness.on('change', ({ added, updated, removed }: { added: number[], updated: number[], removed: number[] }) => {
      for (const id of removed) present.delete(id)
      for (const id of [...added, ...updated]) {
        const state = observer.awareness.getStates().get(id)
        const session: unknown = state?.aiSession
        const status: unknown = state?.aiStatus
        if (typeof session !== 'object' || session === null || typeof status !== 'object' || status === null) continue
        if (Reflect.get(status, 'phase') !== 'job' || present.has(id)) continue
        present.add(id)
        const jobId = String(Reflect.get(session, 'sessionId'))
        appearances.set(jobId, (appearances.get(jobId) ?? 0) + 1)
      }
    })

    const res = await client.post('/api/ai/prompt', { docId: doc.docId, prompt: 'Translate section 2 into English.' })
    expect(res.status).toBe(200)
    const job = await waitFor(async () => {
      const list = await client.get(`/api/docs/${doc.docId}/ai-jobs`)
      if (list.status !== 200) return null
      const { jobs }: { jobs: Array<{ jobId: string, status: string }> } = await list.json()
      return jobs[0]?.status === 'done' ? jobs[0] : null
    }, 90_000, 'the previewed job to be started and finish')
    // Once for the preview, once for the run.
    expect(appearances.get(job.jobId) ?? 0).toBeGreaterThanOrEqual(2)
  }, 180_000)
})
