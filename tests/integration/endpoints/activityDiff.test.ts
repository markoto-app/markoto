import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'
import { TEST_JWT_SECRET } from '../setup/env'
import { mintSessionJwt } from '~~/tests/helpers/jwt'
import { first } from '../../helpers/assert'

// GET /api/docs/:docId/activity/:activityId/diff
//
// On-demand text diff for a single activity row. Replays the doc on
// either side of the row's yjs_doc_id boundaries. Auth gates mirror
// /activity (open-edit/open-view public; private/password gated by
// owner / workspace member / valid doc JWT).
//
// What we lock in here that unit tests can't cover:
//   - Cross-doc activity-id leak: a row from doc B is not readable
//     via /api/docs/A/.../diff/{B-row-id}. Unit tests on the repo
//     helper alone don't prove the endpoint wires the docId filter
//     through.
//   - Real Postgres bytea round-trip: `pg` driver hands `Buffer`s
//     that may share an ArrayBuffer; the replay's `byteOffset`
//     handling has to work against real driver output, not a mock.
//   - Auth gates: every variant from /activity must carry over —
//     anon/owner/workspace-member/doc-JWT — but the diff endpoint
//     duplicated the gate, so it's a separate target for regression.
//   - 410 vs 404: rows from before boundary tracking should 410
//     (the row exists but can't be diffed); unknown rows should 404.

// Encode a minimal Y.js update with the given content text. Returns
// the bytes a sync-server would store as `value` for one v1 row.
function encodeYjsUpdate(content: string): Buffer {
  const doc = new Y.Doc()
  if (content.length > 0) doc.getText('content').insert(0, content)
  const update = Y.encodeStateAsUpdate(doc)
  return Buffer.from(update.buffer, update.byteOffset, update.byteLength)
}

/**
 * Insert a fresh `yjs_updates` row and return its `id`. The
 * activity log boundary ids reference this same `id`.
 */
async function insertYjsRow(docname: string, content: string): Promise<number> {
  const db = testDb()
  const r = await db.query<{ id: number }>(
    `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', $2) RETURNING id`,
    [docname, encodeYjsUpdate(content)]
  )
  return Number(first(r.rows).id)
}

/**
 * Insert one activity row with the given boundary ids. Returns the
 * activity row's id so tests can fetch /diff for it.
 */
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

function mintDocJwt(docId: string): string {
  return mintSessionJwt(
    { docId, userId: 'anonymous', readOnly: false },
    { secret: TEST_JWT_SECRET }
  )
}

describe('GET /api/docs/:docId/activity/:activityId/diff', () => {
  beforeEach(async () => {
    await resetDb()
  })

  describe('happy path', () => {
    it('returns a structured diff for a real edit row', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })

      // Stage two y-postgresql snapshots:
      //   - id=1: empty doc (before)
      //   - id=2: doc with "first line\n" (after)
      const before = await insertYjsRow(doc.docId, '')
      const after = await insertYjsRow(doc.docId, 'first line\n')
      const activityId = await insertActivityRow(doc.docId, before, after)

      const res = await anonClient().get(`/api/docs/${doc.docId}/activity/${activityId}/diff`)
      expect(res.status).toBe(200)
      const body = await res.json() as {
        activityId: number
        before: string
        after: string
        hunks: Array<{ lines: Array<{ kind: string, text: string }> }>
        truncated: boolean
        totalHunks: number
      }
      expect(body.activityId).toBe(activityId)
      expect(body.before).toBe('')
      expect(body.after).toBe('first line\n')
      expect(body.hunks.length).toBeGreaterThan(0)
      // The added line should appear as an `add` line in some hunk.
      const allAdds = body.hunks.flatMap(h => h.lines).filter(l => l.kind === 'add')
      expect(allAdds.some(l => l.text === 'first line')).toBe(true)
      expect(body.truncated).toBe(false)
    })

    it('handles before=null (first edit ever)', async () => {
      // yjsDocIdBefore can legitimately be null when the very first
      // store happens — the replay returns an empty doc and we get
      // an all-add diff.
      const doc = await createDoc({ accessMode: 'open-edit' })
      const after = await insertYjsRow(doc.docId, 'hello\n')
      const activityId = await insertActivityRow(doc.docId, null, after)

      const res = await anonClient().get(`/api/docs/${doc.docId}/activity/${activityId}/diff`)
      expect(res.status).toBe(200)
      const body = await res.json() as { before: string, after: string }
      expect(body.before).toBe('')
      expect(body.after).toBe('hello\n')
    })
  })

  describe('410 — diff unavailable', () => {
    it('returns 410 when yjsDocIdAfter is null (pre-feature row)', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      // Both boundaries null — the row predates the feature.
      const activityId = await insertActivityRow(doc.docId, null, null)

      const res = await anonClient().get(`/api/docs/${doc.docId}/activity/${activityId}/diff`)
      expect(res.status).toBe(410)
    })
  })

  describe('404 — not found / cross-doc isolation', () => {
    it('returns 404 for an unknown activityId', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      const res = await anonClient().get(`/api/docs/${doc.docId}/activity/99999/diff`)
      expect(res.status).toBe(404)
    })

    it('returns 404 for a row that exists but belongs to a different doc (cross-doc leak guard)', async () => {
      // SECURITY: a malicious client could guess an activity id from
      // doc B and try to read its diff via doc A's URL. The endpoint
      // must scope by both docId AND activityId so the lookup misses.
      const docA = await createDoc({ accessMode: 'open-edit' })
      const docB = await createDoc({ accessMode: 'open-edit' })
      const beforeB = await insertYjsRow(docB.docId, '')
      const afterB = await insertYjsRow(docB.docId, 'secret content\n')
      const rowFromB = await insertActivityRow(docB.docId, beforeB, afterB)

      const res = await anonClient().get(`/api/docs/${docA.docId}/activity/${rowFromB}/diff`)
      expect(res.status).toBe(404)
      // Defensive: the response body should NOT include B's content.
      const text = await res.text()
      expect(text).not.toContain('secret content')
    })

    it('returns 400 for an invalid activityId (non-integer)', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      const res = await anonClient().get(`/api/docs/${doc.docId}/activity/not-a-number/diff`)
      expect(res.status).toBe(400)
    })

    it('returns 400 for a negative activityId', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      const res = await anonClient().get(`/api/docs/${doc.docId}/activity/-1/diff`)
      expect(res.status).toBe(400)
    })

    it('returns 404 for a nonexistent doc', async () => {
      const res = await anonClient().get('/api/docs/nonexistent/activity/1/diff')
      expect(res.status).toBe(404)
    })
  })

  describe('auth — open access', () => {
    it('anonymous can read diff on open-edit doc', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      const before = await insertYjsRow(doc.docId, '')
      const after = await insertYjsRow(doc.docId, 'x\n')
      const activityId = await insertActivityRow(doc.docId, before, after)

      const res = await anonClient().get(`/api/docs/${doc.docId}/activity/${activityId}/diff`)
      expect(res.status).toBe(200)
    })

    it('anonymous can read diff on open-view doc', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view' })
      const before = await insertYjsRow(doc.docId, '')
      const after = await insertYjsRow(doc.docId, 'x\n')
      const activityId = await insertActivityRow(doc.docId, before, after)

      const res = await anonClient().get(`/api/docs/${doc.docId}/activity/${activityId}/diff`)
      expect(res.status).toBe(200)
    })
  })

  describe('auth — private mode', () => {
    it('anonymous is denied (403)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const before = await insertYjsRow(doc.docId, '')
      const after = await insertYjsRow(doc.docId, 'private content\n')
      const activityId = await insertActivityRow(doc.docId, before, after)

      const res = await anonClient().get(`/api/docs/${doc.docId}/activity/${activityId}/diff`)
      expect(res.status).toBe(403)
      // Defensive: body must not leak the private content.
      const text = await res.text()
      expect(text).not.toContain('private content')
    })

    it('logged-in non-owner is denied', async () => {
      const owner = await createUser()
      const other = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const before = await insertYjsRow(doc.docId, '')
      const after = await insertYjsRow(doc.docId, 'x\n')
      const activityId = await insertActivityRow(doc.docId, before, after)

      const client = await loggedInClient(other.id)
      const res = await client.get(`/api/docs/${doc.docId}/activity/${activityId}/diff`)
      expect(res.status).toBe(403)
    })

    it('owner can read', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const before = await insertYjsRow(doc.docId, '')
      const after = await insertYjsRow(doc.docId, 'x\n')
      const activityId = await insertActivityRow(doc.docId, before, after)

      const client = await loggedInClient(owner.id)
      const res = await client.get(`/api/docs/${doc.docId}/activity/${activityId}/diff`)
      expect(res.status).toBe(200)
    })

    it.each(['admin', 'editor', 'viewer'] as const)('workspace %s can read', async (role) => {
      const creator = await createUser()
      const member = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, member.id, role)
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const before = await insertYjsRow(doc.docId, '')
      const after = await insertYjsRow(doc.docId, 'x\n')
      const activityId = await insertActivityRow(doc.docId, before, after)

      const client = await loggedInClient(member.id)
      const res = await client.get(`/api/docs/${doc.docId}/activity/${activityId}/diff`)
      expect(res.status).toBe(200)
    })

    it('anonymous with valid doc JWT is allowed', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const before = await insertYjsRow(doc.docId, '')
      const after = await insertYjsRow(doc.docId, 'x\n')
      const activityId = await insertActivityRow(doc.docId, before, after)

      const token = mintDocJwt(doc.docId)
      const res = await anonClient().get(`/api/docs/${doc.docId}/activity/${activityId}/diff`, {
        headers: { authorization: `Bearer ${token}` }
      })
      expect(res.status).toBe(200)
    })

    it('anonymous with JWT for a different doc is denied', async () => {
      // SECURITY: a JWT minted for doc A should NOT unlock diffs for
      // doc B. Pin the gate.
      const owner = await createUser()
      const target = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const decoy = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const before = await insertYjsRow(target.docId, '')
      const after = await insertYjsRow(target.docId, 'x\n')
      const activityId = await insertActivityRow(target.docId, before, after)

      const decoyToken = mintDocJwt(decoy.docId)
      const res = await anonClient().get(`/api/docs/${target.docId}/activity/${activityId}/diff`, {
        headers: { authorization: `Bearer ${decoyToken}` }
      })
      expect(res.status).toBe(403)
    })
  })

  describe('auth — password-protected mode', () => {
    it('anonymous without JWT is denied', async () => {
      const owner = await createUser()
      const doc = await createDoc({
        ownerId: owner.id,
        accessMode: 'password-protected'
      })
      const before = await insertYjsRow(doc.docId, '')
      const after = await insertYjsRow(doc.docId, 'x\n')
      const activityId = await insertActivityRow(doc.docId, before, after)

      const res = await anonClient().get(`/api/docs/${doc.docId}/activity/${activityId}/diff`)
      expect(res.status).toBe(403)
    })

    it('anonymous with valid doc JWT is allowed (matches /activity gate)', async () => {
      const owner = await createUser()
      const doc = await createDoc({
        ownerId: owner.id,
        accessMode: 'password-protected'
      })
      const before = await insertYjsRow(doc.docId, '')
      const after = await insertYjsRow(doc.docId, 'x\n')
      const activityId = await insertActivityRow(doc.docId, before, after)

      const token = mintDocJwt(doc.docId)
      // /activity reads the token from query string for password mode;
      // diff inherits the same gate via decideActivityAccess. Use the
      // header form for parity with the private-mode tests above.
      const res = await anonClient().get(`/api/docs/${doc.docId}/activity/${activityId}/diff`, {
        headers: { authorization: `Bearer ${token}` }
      })
      expect(res.status).toBe(200)
    })
  })
})
