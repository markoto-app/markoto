import { describe, it, expect, beforeEach } from 'vitest'
import { ensureYjsTable, resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'
import { first } from '../../helpers/assert'

// POST /api/docs/:docId/activity/:activityId/restore
//
// Snaps the live Y.Doc to a past state. The endpoint owns auth +
// validation; the actual restoration goes through Hocuspocus, which
// the integration test stack doesn't run (it has an HTTP-only sync
// stub via `syncStub.ts`). So this suite exercises every path that
// completes BEFORE the WS connect:
//   - 401 unauthenticated
//   - 400 malformed activityId
//   - 403 read-only viewer / non-member on a private doc
//   - 404 unknown activityId
//   - 404 activity row from a different doc (cross-doc isolation)
//   - 410 row predates boundary tracking
//
// The "actually restores doc state" path is covered by:
//   1. The `restoreDocToYjsId` unit tests (mocked WS provider)
//   2. The flow-test docker stack which brings up `sync-test` and
//      can drive a real WS round-trip (see scripts/flows-ephemeral.ts)
// Documenting the split here so the gap doesn't masquerade as a
// missing test.

async function insertActivityRow(
  docId: string,
  yjsDocIdBefore: number | null,
  yjsDocIdAfter: number | null,
  options: { action?: string, userName?: string } = {}
): Promise<number> {
  const db = testDb()
  const r = await db.query<{ id: number }>(
    `INSERT INTO activity_log (doc_id, user_name, action, lines_added, lines_removed, yjs_doc_id_before, yjs_doc_id_after)
     VALUES ($1, $2, $3, 1, 0, $4, $5)
     RETURNING id`,
    [docId, options.userName ?? 'Alice', options.action ?? 'edit', yjsDocIdBefore, yjsDocIdAfter]
  )
  return first(r.rows).id
}

async function insertYjsRow(docname: string, _content: string): Promise<number> {
  const db = testDb()
  // Minimal valid Y.js update encoded for the row. Doesn't need to
  // be replayable for these tests — the auth/validation gates fire
  // before any replay happens.
  const fakeBytes = Buffer.from([0, 0]) // empty Y.js update header
  const r = await db.query<{ id: number }>(
    `INSERT INTO yjs_documents (docname, value, version) VALUES ($1, $2, 'v1') RETURNING id`,
    [docname, fakeBytes]
  )
  return first(r.rows).id
}

describe('POST /api/docs/:docId/activity/:activityId/restore', () => {
  beforeEach(async () => {
    await resetDb()
    await ensureYjsTable()
  })

  describe('validation', () => {
    it('returns 401 for unauthenticated callers', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const yjsId = await insertYjsRow(doc.docId, '')
      const activityId = await insertActivityRow(doc.docId, yjsId, yjsId)

      const res = await anonClient().post(
        `/api/docs/${doc.docId}/activity/${activityId}/restore`,
        {}
      )
      expect(res.status).toBe(401)
    })

    it('returns 400 for a non-integer activityId', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const client = await loggedInClient(owner.id)
      const res = await client.post(
        `/api/docs/${doc.docId}/activity/not-a-number/restore`,
        {}
      )
      expect(res.status).toBe(400)
    })

    it('returns 400 for a negative activityId', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const client = await loggedInClient(owner.id)
      const res = await client.post(
        `/api/docs/${doc.docId}/activity/-1/restore`,
        {}
      )
      expect(res.status).toBe(400)
    })
  })

  describe('auth — edit access required', () => {
    it('returns 403 for a logged-in non-member on a private doc', async () => {
      const owner = await createUser()
      const other = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const yjsId = await insertYjsRow(doc.docId, '')
      const activityId = await insertActivityRow(doc.docId, yjsId, yjsId)

      const client = await loggedInClient(other.id)
      const res = await client.post(
        `/api/docs/${doc.docId}/activity/${activityId}/restore`,
        {}
      )
      expect(res.status).toBe(403)
    })

    it('returns 403 for a workspace VIEWER (read-only)', async () => {
      // SECURITY: viewers can SEE diffs (Tier 1) but must not be able
      // to APPLY them. The restore endpoint deliberately uses the
      // edit-gate, not the view-gate.
      const creator = await createUser()
      const viewer = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const yjsId = await insertYjsRow(doc.docId, '')
      const activityId = await insertActivityRow(doc.docId, yjsId, yjsId)

      const client = await loggedInClient(viewer.id)
      const res = await client.post(
        `/api/docs/${doc.docId}/activity/${activityId}/restore`,
        {}
      )
      expect(res.status).toBe(403)
    })

    it.each(['admin', 'editor'] as const)('workspace %s gets past the auth gate', async (role) => {
      // Admins + editors have edit access. They get past the gate, then
      // the request flows on to the restore-execution path. In this
      // test stack the WS connect will time out (no real Hocuspocus),
      // so we just verify the gate passed by checking we DON'T see
      // 403 (status will be 500 from the WS timeout, which is correct
      // for this stack — proves auth let it through).
      const creator = await createUser()
      const member = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, member.id, role)
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const yjsId = await insertYjsRow(doc.docId, '')
      const activityId = await insertActivityRow(doc.docId, yjsId, yjsId)

      const client = await loggedInClient(member.id)
      const res = await client.post(
        `/api/docs/${doc.docId}/activity/${activityId}/restore`,
        {}
      )
      // 200 (full sync stack), 500 (no Hocuspocus in this test
      // harness — the request DID get past the auth gate but the
      // WS connect timed out). 403 would be a real bug.
      expect([200, 500]).toContain(res.status)
    }, 30_000)
  })

  describe('404 — not found / cross-doc isolation', () => {
    it('returns 404 for an unknown activityId', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const client = await loggedInClient(owner.id)
      const res = await client.post(
        `/api/docs/${doc.docId}/activity/99999/restore`,
        {}
      )
      expect(res.status).toBe(404)
    })

    it('returns 404 for an activity row that belongs to a different doc (cross-doc leak guard)', async () => {
      // SECURITY: a malicious client could guess an activity id from
      // doc B and try to use it via doc A's URL. The endpoint must
      // scope on (docId, activityId) so the lookup misses.
      const owner = await createUser()
      const docA = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const docB = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const yjsB = await insertYjsRow(docB.docId, '')
      const rowFromB = await insertActivityRow(docB.docId, yjsB, yjsB)

      const client = await loggedInClient(owner.id)
      const res = await client.post(
        `/api/docs/${docA.docId}/activity/${rowFromB}/restore`,
        {}
      )
      expect(res.status).toBe(404)
    })

    it('returns 404 for a nonexistent doc', async () => {
      const owner = await createUser()
      const client = await loggedInClient(owner.id)
      const res = await client.post(`/api/docs/nonexistent/activity/1/restore`, {})
      // requireDocEditAccess returns 404 when the doc doesn't exist
      // (the standard pattern for missing-doc protection — we don't
      // expose whether the user WOULD have had access).
      expect(res.status).toBe(404)
    })
  })

  describe('410 — restore unavailable', () => {
    it('returns 410 when the activity row has yjsDocIdBefore=null (pre-feature)', async () => {
      // Pre-Tier-1 activity rows weren't stamped with boundary ids.
      // The endpoint can't compute a "before" state to restore TO —
      // surface this as 410 (matches the diff endpoint's contract).
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const activityId = await insertActivityRow(doc.docId, null, null)

      const client = await loggedInClient(owner.id)
      const res = await client.post(
        `/api/docs/${doc.docId}/activity/${activityId}/restore`,
        {}
      )
      expect(res.status).toBe(410)
    })

    // Data-loss guard: y-postgresql compaction physically DELETES every granular `v1` row below the merged row.
    // Restoring to a target below that surviving floor must be refused with 410, not reconstruct an EMPTY doc
    // and WIPE the live doc.
    it('returns 410 (does NOT wipe) when the target id is below the compaction floor', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const low = await insertYjsRow(doc.docId, '') // target — gets compacted away
      await insertYjsRow(doc.docId, '')
      const merged = await insertYjsRow(doc.docId, '') // stands in for the merged row
      const activityId = await insertActivityRow(doc.docId, low, low)
      // Simulate `clearUpdatesRange`: delete every v1 row below the merged one.
      await testDb().query(
        `DELETE FROM yjs_documents WHERE docname = $1 AND version = 'v1' AND id < $2`,
        [doc.docId, merged]
      )

      const client = await loggedInClient(owner.id)
      const res = await client.post(
        `/api/docs/${doc.docId}/activity/${activityId}/restore`,
        {}
      )
      // 410 = guard fired pre-apply. A 200/500 here would mean it attempted the
      // restore with an empty reconstruction — i.e. the doc-wipe bug.
      expect(res.status).toBe(410)
    })

    it('does NOT 410 when the target id is AT the compaction floor (still reconstructable)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      await insertYjsRow(doc.docId, '')
      await insertYjsRow(doc.docId, '')
      const floor = await insertYjsRow(doc.docId, '')
      const activityId = await insertActivityRow(doc.docId, floor, floor)
      await testDb().query(
        `DELETE FROM yjs_documents WHERE docname = $1 AND version = 'v1' AND id < $2`,
        [doc.docId, floor]
      )

      const client = await loggedInClient(owner.id)
      const res = await client.post(
        `/api/docs/${doc.docId}/activity/${activityId}/restore`,
        {}
      )
      // target == floor → the merged row IS included by `id <= target`, so the
      // guard must NOT fire. Falls through to the WS path: 200 (full stack) or
      // 500 (no Hocuspocus in this harness). Just never 410.
      expect([200, 500]).toContain(res.status)
    }, 30_000)
  })

  describe('failure path — atomicity', () => {
    it('does NOT write a `restore` activity row when the restore execution fails', async () => {
      // SECURITY/CORRECTNESS: when restoreDocToYjsId throws (e.g. WS
      // timeout in this test stack), no activity row should be left
      // behind claiming a successful restore. Otherwise the panel
      // would show a phantom restore that didn't actually happen.
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const yjsId = await insertYjsRow(doc.docId, '')
      const activityId = await insertActivityRow(doc.docId, yjsId, yjsId)

      const client = await loggedInClient(owner.id)
      const res = await client.post(
        `/api/docs/${doc.docId}/activity/${activityId}/restore`,
        {}
      )
      // 500 in this stack (real Hocuspocus would give 200). Either
      // way there should be no orphan `restore` row.
      expect([200, 500]).toContain(res.status)

      // A 200 legitimately leaves a `restore` row; only the failed restore must leave none.
      let orphanRestoreRows = 0
      if (res.status === 500) {
        const db = testDb()
        const r = await db.query<{ c: string }>(
          `SELECT COUNT(*) AS c FROM activity_log WHERE doc_id = $1 AND action = 'restore'`,
          [doc.docId]
        )
        orphanRestoreRows = Number(first(r.rows).c)
      }
      expect(orphanRestoreRows).toBe(0)
    }, 30_000)
  })
})
