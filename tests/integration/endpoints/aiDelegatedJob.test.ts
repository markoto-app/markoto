import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createDoc } from '../setup/fixtures'
import { fakeOpenAiBaseUrl } from '../setup/env'
import { byokUser, connectSync, resetFake, uniqueKey, waitFor, waitForAcked, writeDocAs, type SyncClient } from '../setup/byok'

// A delegated translation end to end, through the real prompt route, loop,
// job engine, LiteLLM and sync server: the `obedient-chat` fake planner
// reads the document and follows the FAKE_DIRECTIVE line in it, which calls
// delegate_rewrite with action "start" on section 2; the fake answers the
// job's worker calls with English filler that keeps headings and
// placeholders (tests/fixtures/fake-openai/server.py). Checks the document
// changed (code untouched), the `ai.job` activity row, the job routes'
// initiator-only rule, and that Undo job restores the German text, also
// after the planner corrected the job's output (`FAKE_AFTER_JOB`), but
// never over a person's later edit.

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

/**
 * Every background job asks the initiator before it starts (the prompt
 * bar's Start / Cancel): wait for the job confirmation of the session and
 * answer Start, as the user would.
 */
async function startWhenAsked(client: Awaited<ReturnType<typeof loggedInClient>>, sessionId: string): Promise<{ units: number, minutes: number }> {
  const pending = await waitFor(async () => {
    const r = await client.get(`/api/ai/sessions/${sessionId}`)
    if (r.status !== 200) return null
    const view: { confirmation: { id: string, kind?: string, job?: { units: number, minutes: number } } | null } = await r.json()
    return view.confirmation?.kind === 'job' ? view.confirmation : null
  }, 60_000, 'the job confirmation')
  const answer = await client.post(`/api/ai/sessions/${sessionId}/confirm`, { confirmationId: pending.id, allow: true })
  expect(answer.status).toBe(200)
  return pending.job!
}

/**
 * The planner's correction once the job has finished: a regex the line
 * holding it does not match itself (it reads `\\s`, not a space), so only
 * the translated text changes.
 */
const AFTER_JOB = `FAKE_AFTER_JOB replace_all ${JSON.stringify({ query: 'reads\\s+clearly', replacement: 'reads well', regex: true, preview: false })}`

type Client = Awaited<ReturnType<typeof loggedInClient>>

/** Alice with the obedient fake planner and a document holding `original`; runs the prompt, answers Start and waits for the job. */
async function runTranslation(original: string, keyTag: string): Promise<{ client: Client, docId: string, userId: number, jobId: string, sessionId: string }> {
  const alice = await byokUser('Alice')
  const client = await loggedInClient(alice.id, 'Alice')
  const put = await client.put('/api/user/ai-providers/chat', { baseUrl: FAKE, model: 'obedient-chat', apiKey: uniqueKey(keyTag), supportsVision: false })
  expect(put.status).toBe(200)
  const doc = await createDoc({ ownerId: alice.id, title: 'Teamhandbuch' })
  syncClients.push(await writeDocAs(doc.docId, { userId: String(alice.id), userName: 'Alice' }, original))
  const res = await client.post('/api/ai/prompt', { docId: doc.docId, prompt: 'Translate section 2 into English.' })
  expect(res.status).toBe(200)
  const { sessionId } = (await res.json()) as { sessionId: string }
  await startWhenAsked(client, sessionId)
  const job = await waitFor(async () => {
    const list = await client.get(`/api/docs/${doc.docId}/ai-jobs`)
    if (list.status !== 200) return null
    const { jobs }: { jobs: Array<{ jobId: string, status: string }> } = await list.json()
    return jobs[0]?.status === 'done' ? jobs[0] : null
  }, 90_000, 'the delegated job to finish')
  return { client, docId: doc.docId, userId: alice.id, jobId: job.jobId, sessionId }
}

/** The AI session has ended (its last edits are in the document). */
async function sessionEnded(client: Client, sessionId: string): Promise<void> {
  await waitFor(async () => {
    const r = await client.get(`/api/ai/sessions/${sessionId}`)
    if (r.status === 404) return true
    const view: { phase?: string } = await r.json()
    return view.phase === 'done' || view.phase === 'error' ? true : null
  }, 60_000, 'the AI session to end')
}

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
    // Even this one-part job waits for Start, and the question has no cost in it.
    const asked = await startWhenAsked(client, ((await res.json()) as { sessionId: string }).sessionId)
    expect(asked.units).toBe(1)

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
    expect(await revert.json()).toEqual({ reverted: 1, followUps: 0, skipped: 0, kept: [] })
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
    await startWhenAsked(client, ((await res.json()) as { sessionId: string }).sessionId)
    const job = await waitFor(async () => {
      const list = await client.get(`/api/docs/${doc.docId}/ai-jobs`)
      if (list.status !== 200) return null
      const { jobs }: { jobs: Array<{ jobId: string, status: string }> } = await list.json()
      return jobs[0]?.status === 'done' ? jobs[0] : null
    }, 90_000, 'the previewed job to be started and finish')
    // Once for the preview, once for the run.
    expect(appearances.get(job.jobId) ?? 0).toBeGreaterThanOrEqual(2)
  }, 180_000)

  it('Undo job also undoes the corrections the job\'s own AI session made afterwards', async () => {
    // Staging: after a translation the planner fixed glossary drift in four
    // chapters; Undo then skipped those as "changed since" and left them English.
    const original = `# 1 Einleitung\n\nDieses Handbuch ist für das Team.\n${directive()}\n${AFTER_JOB}\n\n${SECTION_2}`
    const run = await runTranslation(original, 'job-follow')
    await waitFor(async () => ((await readDoc(run.docId, run.userId)).includes('reads well') ? true : null), 30_000, 'the planner\'s correction')
    await sessionEnded(run.client, run.sessionId)

    const revert = await run.client.post(`/api/docs/${run.docId}/ai-jobs/${run.jobId}/revert`, {})
    expect(revert.status).toBe(200)
    expect(await revert.json()).toEqual({ reverted: 1, followUps: 1, skipped: 0, kept: [] })
    await waitFor(async () => ((await readDoc(run.docId, run.userId)) === original ? true : null), 15_000, 'the German text to come back')
  }, 180_000)

  it('Undo job keeps a part a person changed after the job and says which and why', async () => {
    const original = `# 1 Einleitung\n\nDieses Handbuch ist für das Team.\n${directive()}\n\n${SECTION_2}`
    const run = await runTranslation(original, 'job-human')
    await sessionEnded(run.client, run.sessionId)
    const editor = connectSync(run.docId, { userId: String(run.userId), userName: 'Alice' })
    syncClients.push(editor)
    await editor.synced
    const text = editor.doc.getText('content')
    await waitFor(async () => (text.toString().includes('Translated heading') ? true : null), 15_000, 'the translation in the editor')
    const at = text.toString().indexOf('This translated text')
    editor.doc.transact(() => text.insert(at, 'Note: '))
    await waitForAcked(editor)

    const revert = await run.client.post(`/api/docs/${run.docId}/ai-jobs/${run.jobId}/revert`, {})
    expect(revert.status).toBe(200)
    const body: { reverted: number, followUps: number, skipped: number, kept: Array<{ headingPath: string, kind: string }> } = await revert.json()
    expect(body).toMatchObject({ reverted: 0, followUps: 0, skipped: 1 })
    expect(body.kept).toEqual([{ headingPath: expect.stringContaining('Installation'), kind: 'edited' }])
    expect(await readDoc(run.docId, run.userId)).toContain('Note: This translated text')
  }, 180_000)
})
