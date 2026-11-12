import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { resetDb, testDb } from '../setup/db'
import { anonClient } from '../setup/client'
import { createDoc } from '../setup/fixtures'
import { TEST_INTERNAL_SECRET } from '../setup/env'
import { first } from '../../helpers/assert'

// End-to-end smoke test for the edit → activity → diff pipeline.
// Doesn't actually run Hocuspocus — instead it synthesizes the same
// row shape the sync-server writes:
//   1. Insert a yjs_updates row representing pre-edit state.
//   2. Insert a yjs_updates row representing post-edit state.
//   3. POST to /api/internal/activity with the boundary ids.
//   4. GET /api/docs/:docId/activity/:activityId/diff.
//   5. Assert the diff response shows the exact change.
//
// Why this matters even though each layer has its own tests:
//   - The sync-server, the internal endpoint, and the diff endpoint
//     each touch the boundary ids — a bug at any seam (off-by-one,
//     wrong field name, integer vs string) produces a broken
//     end-to-end experience that no single layer's tests would
//     catch.
//   - The pg driver's bytea encoding has to round-trip through the
//     replay path against real Postgres — the unit tests use mocks,
//     so a real driver quirk could slip through.
//   - The activity-row → diff endpoint linkage must work via the
//     row id, scoped to the right docId. Pin it.

const secretHeaders = { 'x-internal-secret': TEST_INTERNAL_SECRET }

// Stage a doc's state through a series of mutations. Each step
// returns the y-postgresql row id corresponding to the doc's state
// at that point. We replay against the SAME Y.Doc throughout so the
// updates form a coherent history (single clientId, monotonic
// clocks) — exactly what y-postgresql's storage looks like in
// production after a series of stores.
async function stageStates(docname: string, contents: string[]): Promise<number[]> {
  const doc = new Y.Doc()
  const ytext = doc.getText('content')
  const ids: number[] = []
  const db = testDb()
  let lastContent = ''
  for (const next of contents) {
    // Diff lastContent → next via a naive replace-all so the doc's
    // ytext converges on the target. Real Y.js edits would be
    // line-level, but the encoded full-state update is the same
    // shape either way once you call encodeStateAsUpdate.
    ytext.delete(0, lastContent.length)
    if (next.length > 0) ytext.insert(0, next)
    const update = Y.encodeStateAsUpdate(doc)
    const value = Buffer.from(update.buffer, update.byteOffset, update.byteLength)
    const r = await db.query<{ id: number }>(
      `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', $2) RETURNING id`,
      [docname, value]
    )
    ids.push(Number(first(r.rows).id))
    lastContent = next
  }
  return ids
}

async function postActivity(payload: Record<string, unknown>): Promise<Response> {
  return anonClient().post('/api/internal/activity', payload, { headers: secretHeaders })
}

interface DiffResponse {
  activityId: number
  before: string
  after: string
  hunks: Array<{
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: Array<{ kind: 'context' | 'add' | 'remove', text: string }>
  }>
  truncated: boolean
  totalHunks: number
}

describe('edit → activity row → diff endpoint round-trip', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('writes an activity row through /internal/activity and serves a real diff for it', async () => {
    const doc = await createDoc({ accessMode: 'open-edit' })
    const [before, after] = await stageStates(doc.docId, [
      'line A\nline B\n',
      'line A\nline B\nline C added\n'
    ])

    // Hit the internal endpoint exactly the way the sync-server does
    // (matching the field names from sync-server/src/activity-logger.ts).
    const writeRes = await postActivity({
      docId: doc.docId,
      userName: 'Alice',
      action: 'edit',
      wordCount: 6,
      linesAdded: 1,
      linesRemoved: 0,
      yjsDocIdBefore: before,
      yjsDocIdAfter: after
    })
    expect(writeRes.status).toBe(200)

    // Find the row id we just wrote (we don't get it back from the
    // endpoint; query the table).
    const db = testDb()
    const r = await db.query<{ id: number }>(
      `SELECT id FROM activity_log WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
      [doc.docId]
    )
    const activityId = first(r.rows).id

    // Now fetch the diff.
    const diffRes = await anonClient().get(`/api/docs/${doc.docId}/activity/${activityId}/diff`)
    expect(diffRes.status).toBe(200)
    const body = await diffRes.json() as DiffResponse

    // Sanity: the activity id is echoed back.
    expect(body.activityId).toBe(activityId)
    // The replay reproduces the exact pre/post text we staged.
    expect(body.before).toBe('line A\nline B\n')
    expect(body.after).toBe('line A\nline B\nline C added\n')

    // The diff captures the single added line as one `add` line in
    // some hunk — and there's no spurious removal.
    expect(body.hunks).toHaveLength(1)
    const hunk = first(body.hunks)
    const adds = hunk.lines.filter(l => l.kind === 'add')
    const removes = hunk.lines.filter(l => l.kind === 'remove')
    expect(adds).toHaveLength(1)
    expect(first(adds).text).toBe('line C added')
    expect(removes).toHaveLength(0)
  })

  it('reproduces a multi-line modification (add + remove) through the round-trip', async () => {
    const doc = await createDoc({ accessMode: 'open-edit' })
    const [before, after] = await stageStates(doc.docId, [
      'old line one\nshared\nold line three\n',
      'new line one\nshared\nnew line three\n'
    ])

    await postActivity({
      docId: doc.docId,
      userName: 'Alice',
      action: 'edit',
      linesAdded: 2,
      linesRemoved: 2,
      yjsDocIdBefore: before,
      yjsDocIdAfter: after
    })

    const db = testDb()
    const r = await db.query<{ id: number }>(
      `SELECT id FROM activity_log WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
      [doc.docId]
    )
    const activityId = first(r.rows).id

    const diffRes = await anonClient().get(`/api/docs/${doc.docId}/activity/${activityId}/diff`)
    expect(diffRes.status).toBe(200)
    const body = await diffRes.json() as DiffResponse

    const allAdds = body.hunks.flatMap(h => h.lines).filter(l => l.kind === 'add')
    const allRemoves = body.hunks.flatMap(h => h.lines).filter(l => l.kind === 'remove')
    expect(allAdds.map(l => l.text).sort()).toEqual(['new line one', 'new line three'])
    expect(allRemoves.map(l => l.text).sort()).toEqual(['old line one', 'old line three'])
  })

  it('handles a bare-doc first-edit scenario (yjsDocIdBefore=null)', async () => {
    // The very first store on a fresh doc has no prior y-postgresql
    // row; the sync-server writes yjsDocIdBefore=null for that case.
    // The diff should treat it as "before" being empty.
    const doc = await createDoc({ accessMode: 'open-edit' })
    const [after] = await stageStates(doc.docId, ['first ever line\n'])

    await postActivity({
      docId: doc.docId,
      userName: 'Alice',
      action: 'edit',
      linesAdded: 1,
      linesRemoved: 0,
      yjsDocIdBefore: null,
      yjsDocIdAfter: after
    })

    const db = testDb()
    const r = await db.query<{ id: number }>(
      `SELECT id FROM activity_log WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
      [doc.docId]
    )
    const activityId = first(r.rows).id

    const diffRes = await anonClient().get(`/api/docs/${doc.docId}/activity/${activityId}/diff`)
    expect(diffRes.status).toBe(200)
    const body = await diffRes.json() as DiffResponse
    expect(body.before).toBe('')
    expect(body.after).toBe('first ever line\n')
    const adds = body.hunks.flatMap(h => h.lines).filter(l => l.kind === 'add')
    expect(adds.map(l => l.text)).toEqual(['first ever line'])
  })

  it('the activity row\'s userName attribution flows through to the GET /activity response', async () => {
    // Cross-check: the user-name we write through /internal/activity
    // is the user-name shown in /activity. Pins the field-name
    // contract between sync-server and the read endpoint.
    const doc = await createDoc({ accessMode: 'open-edit' })
    const [before, after] = await stageStates(doc.docId, ['', 'x\n'])

    await postActivity({
      docId: doc.docId,
      userName: 'Specific Identity',
      action: 'edit',
      linesAdded: 1,
      linesRemoved: 0,
      yjsDocIdBefore: before,
      yjsDocIdAfter: after
    })

    const listRes = await anonClient().get(`/api/docs/${doc.docId}/activity`)
    expect(listRes.status).toBe(200)
    const entries = await listRes.json() as Array<{ userName: string, action: string }>
    expect(entries.some(e => e.userName === 'Specific Identity' && e.action === 'edit')).toBe(true)
  })

  it('preserves boundary ids across the activity GET response shape', async () => {
    // The list endpoint MUST surface yjsDocIdBefore + yjsDocIdAfter
    // so the UI can decide whether to render a "View change" affordance
    // (rows with yjsDocIdAfter === null show the unavailable state).
    const doc = await createDoc({ accessMode: 'open-edit' })
    const [before, after] = await stageStates(doc.docId, ['', 'x\n'])

    await postActivity({
      docId: doc.docId,
      userName: 'Alice',
      action: 'edit',
      linesAdded: 1,
      linesRemoved: 0,
      yjsDocIdBefore: before,
      yjsDocIdAfter: after
    })

    const listRes = await anonClient().get(`/api/docs/${doc.docId}/activity`)
    const entries = await listRes.json() as Array<{
      userName: string
      action: string
      yjsDocIdBefore: number | null
      yjsDocIdAfter: number | null
    }>
    const row = entries.find(e => e.userName === 'Alice' && e.action === 'edit')
    expect(row).toBeDefined()
    expect(row!.yjsDocIdBefore).toBe(before)
    expect(row!.yjsDocIdAfter).toBe(after)
  })
})
