import { describe, it, expect, vi, beforeEach } from 'vitest'
import { API_ERRORS } from '../../../shared/api/errors'
import { asUser, docAs } from '../../helpers/access'

// Unit-style test for the POST /api/docs/:docId/activity/:activityId/restore
// endpoint handler. The integration suite (tests/integration/endpoints/
// activityRestore.test.ts) exercises the validation/auth/404/410/atomicity
// branches via real HTTP, but it can't reach the success-path body
// assertions because the test stack has no Hocuspocus to land the
// restore. THIS suite mocks `restoreDocToYjsId` so we never need a WS
// connection: and uses that to pin this regression target:
//
//   The new `restore` activity row's `yjsDocIdBefore` MUST be the
//   helper's `yjsDocIdBeforeRestore` (the LIVE pre-restore state),
//   NOT the source row's `yjsDocIdBefore` (the past target).
//
// Mistaking those two on the activity-row write would silently break
// the "restore IS reversible, clicking restore on a restore row brings
// the doc back to the pre-restore state" promise. The bug renders no
// error; clicking would simply re-snap to the same past state. Cheap
// to write here, expensive to debug in production.

// Mocks (must register before importing the SUT)

const getActivityById = vi.fn()
const appendActivity = vi.fn(async () => {})
const pruneActivity = vi.fn(async () => {})
const restoreDocToYjsId = vi.fn()
const findUserName = vi.fn(async (): Promise<string | null> => 'Alice')
const nanoidFn = vi.fn(() => 'fixed-session-id')
const resolveDocPlan = vi.fn(async () => 'free')
const assertWithinHistory = vi.fn((_plan: string, _createdAt: Date) => {})

vi.mock('../../../server/repos/activity', () => ({
  getActivityById, appendActivity, pruneActivity
}))
vi.mock('../../../server/utils/documents/restoreDoc', () => ({
  restoreDocToYjsId,
  // Real class so the endpoint's `e instanceof RestorePointCompactedError`
  // check resolves. Generic thrown errors aren't instances → 500 path.
  RestorePointCompactedError: class RestorePointCompactedError extends Error {}
}))
vi.mock('../../../server/repos/users', () => ({ findUserName }))
vi.mock('nanoid', () => ({ nanoid: nanoidFn }))
vi.mock('../../../server/utils/billing/entitlements', () => ({ resolveDocPlan, assertWithinHistory }))

// The SUT is a `defineApiHandler` route: the stub captures its declaration.
// `call()` replays what the wrapper does before the handler, params schema
// (400), then the access policy (pinned by tests/unit/platform/defineApiHandler.test.ts
// for `write-content`): and hands the handler the context a signed-in
// editor gets.
interface CapturedDef {
  access: { kind: string, need: string, deny?: string }
  params: { safeParse: (v: unknown) => { success: true, data: { docId: string, activityId: number } } | { success: false } }
  handler: (ctx: unknown) => Promise<unknown>
}
let def: CapturedDef | null = null
vi.stubGlobal('defineApiHandler', (d: CapturedDef) => {
  def = d
  return d
})
vi.stubGlobal('allow', { doc: (need: string, o: object) => ({ kind: 'doc', need, ...o }) })
vi.stubGlobal('apiError', (code: keyof typeof API_ERRORS) => Object.assign(new Error(code), { statusCode: API_ERRORS[code].status, data: { code } }))

const resolveAccess = vi.fn(async (_docId: string) => ({ user: { id: 7, name: 'Alice' } }))

await import('../../../server/api/docs/[docId]/activity/[activityId]/restore.post')

async function call(docId: string, activityId: string | number): Promise<unknown> {
  const parsed = def!.params.safeParse({ docId, activityId: String(activityId) })
  if (!parsed.success) throw Object.assign(new Error('invalid'), { statusCode: 400 })
  const { user } = await resolveAccess(docId)
  // The policy hands the handler a write proof for the URL document.
  return def!.handler({ user, self: asUser(user.id), docId, docAccess: docAs(docId, user.id), params: parsed.data })
}

interface ActivityRow {
  id: number
  docId: string
  userId: number | null
  userName: string | null
  action: string
  yjsDocIdBefore: number | null
  yjsDocIdAfter: number | null
  createdAt: Date
  metadata: unknown
}

function fakeActivityRow(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 41,
    docId: 'doc-1',
    userId: 9,
    userName: 'Bob',
    action: 'edit',
    yjsDocIdBefore: 30,
    yjsDocIdAfter: 35,
    createdAt: new Date('2026-04-28T12:00:00Z'),
    metadata: null,
    ...over
  }
}

beforeEach(() => {
  resolveAccess.mockReset()
  resolveAccess.mockResolvedValue({ user: { id: 7, name: 'Alice' } })
  getActivityById.mockReset()
  appendActivity.mockReset()
  appendActivity.mockResolvedValue(undefined)
  pruneActivity.mockReset()
  pruneActivity.mockResolvedValue(undefined)
  restoreDocToYjsId.mockReset()
  findUserName.mockReset()
  findUserName.mockResolvedValue('Alice')
  nanoidFn.mockReset()
  nanoidFn.mockReturnValue('fixed-session-id')
  resolveDocPlan.mockReset()
  resolveDocPlan.mockResolvedValue('free')
  assertWithinHistory.mockReset()
  assertWithinHistory.mockImplementation(() => {})
})

describe('POST /api/docs/:docId/activity/:activityId/restore: handler', () => {
  it('rejects malformed activityId with 400 BEFORE consulting the DB', async () => {
    // The validation order is load-bearing: a bad id should fail fast
    // without touching auth or DB (the params schema runs before the
    // access policy).
    await expect(call('doc-1', 'not-a-number'))
      .rejects.toMatchObject({ statusCode: 400 })

    expect(resolveAccess).not.toHaveBeenCalled()
    expect(getActivityById).not.toHaveBeenCalled()
    expect(restoreDocToYjsId).not.toHaveBeenCalled()
  })

  it('rejects activityId <= 0 with 400', async () => {
    await expect(call('doc-1', '-1'))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns 404 when getActivityById returns null (cross-doc isolation, unknown id)', async () => {
    getActivityById.mockResolvedValueOnce(null)

    await expect(call('doc-1', '99'))
      .rejects.toMatchObject({ statusCode: 404 })

    // Pin the (activityId, docId) tuple, the cross-doc leak guard
    // depends on the docId being passed to the repo.
    expect(getActivityById).toHaveBeenCalledWith(expect.objectContaining({ docId: 'doc-1' }), 99)
    expect(restoreDocToYjsId).not.toHaveBeenCalled()
  })

  it('returns 410 when the source row predates boundary tracking (yjsDocIdBefore=null)', async () => {
    getActivityById.mockResolvedValueOnce(fakeActivityRow({ yjsDocIdBefore: null }))

    await expect(call('doc-1', '41'))
      .rejects.toMatchObject({ statusCode: 410 })

    expect(restoreDocToYjsId).not.toHaveBeenCalled()
    expect(appendActivity).not.toHaveBeenCalled()
  })

  it('passes the SOURCE row\'s yjsDocIdBefore as the restore target', async () => {
    // The "restore" semantic: clicking restore on row X brings the
    // doc back to row X's BEFORE state, i.e., the state right
    // before X happened. Using `yjsDocIdAfter` here would restore
    // to the state right AFTER X happened, which is a no-op when
    // X is the immediately-prior row.
    getActivityById.mockResolvedValueOnce(fakeActivityRow({ yjsDocIdBefore: 30, yjsDocIdAfter: 35 }))
    restoreDocToYjsId.mockResolvedValueOnce({
      yjsDocIdBeforeRestore: 100,
      yjsDocIdAfterRestore: 110
    })

    await call('doc-1', '41')

    expect(restoreDocToYjsId).toHaveBeenCalledTimes(1)
    expect(restoreDocToYjsId).toHaveBeenCalledWith(expect.objectContaining({
      doc: expect.objectContaining({ docId: 'doc-1' }),
      targetYjsId: 30, // source row's BEFORE, not 35
      actorUserId: 7,
      actorName: 'Alice',
      sessionId: 'fixed-session-id'
    }))
  })

  it('falls back to "User" actor name when findUserName returns null', async () => {
    // The restore still happens, only the awareness label collaborators
    // see during the broadcast falls back. Pinning here so a future
    // change that throws on null userName surfaces immediately.
    findUserName.mockResolvedValueOnce(null)
    getActivityById.mockResolvedValueOnce(fakeActivityRow())
    restoreDocToYjsId.mockResolvedValueOnce({
      yjsDocIdBeforeRestore: 100,
      yjsDocIdAfterRestore: 110
    })

    await call('doc-1', '41')

    expect(restoreDocToYjsId).toHaveBeenCalledWith(expect.objectContaining({
      actorName: 'User'
    }))
    expect(appendActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userName: 'User'
    }))
  })

  it('writes the restore activity row with the LIVE pre-restore yjsDocIdBefore (regression target)', async () => {
    // The new restore row's `yjsDocIdBefore` must be the LIVE state captured BEFORE the restore landed (helper
    // return field `yjsDocIdBeforeRestore`), NOT the source row's `yjsDocIdBefore` (the past target). Otherwise
    // reversibility breaks: clicking restore on the new restore row would re-snap to the same past state instead
    // of bringing the doc back to the pre-restore live state.
    getActivityById.mockResolvedValueOnce(fakeActivityRow({
      yjsDocIdBefore: 30,
      yjsDocIdAfter: 35,
      createdAt: new Date('2026-04-28T11:00:00Z')
    }))
    restoreDocToYjsId.mockResolvedValueOnce({
      yjsDocIdBeforeRestore: 100, // LIVE state captured before WS connect
      yjsDocIdAfterRestore: 110 // LIVE state after the inverse update
    })

    await call('doc-1', '41')

    expect(appendActivity).toHaveBeenCalledTimes(1)
    expect(appendActivity).toHaveBeenCalledWith(expect.objectContaining({ docId: 'doc-1' }), expect.objectContaining({
      userId: 7,
      userName: 'Alice',
      action: 'restore',
      // ✅ The reversibility-critical pin. If a refactor accidentally
      // wires `activity.yjsDocIdBefore` (=30) here instead of the
      // helper's `yjsDocIdBeforeRestore` (=100), this fails.
      yjsDocIdBefore: 100,
      yjsDocIdAfter: 110,
      metadata: {
        kind: 'restore',
        restoredFromActivityId: 41,
        restoredFromTime: '2026-04-28T11:00:00.000Z'
      }
    }))
  })

  it('runs pruneActivity AFTER appendActivity (so the new row isn\'t pruned out from under itself)', async () => {
    // pruneActivity caps the per-doc activity at 500 rows. Calling it
    // BEFORE appendActivity would leave a 501-row table briefly; the
    // existing pattern always appends first, then prunes. Pin the
    // order so a refactor doesn't quietly invert it.
    getActivityById.mockResolvedValueOnce(fakeActivityRow())
    restoreDocToYjsId.mockResolvedValueOnce({
      yjsDocIdBeforeRestore: 100,
      yjsDocIdAfterRestore: 110
    })

    const callOrder: string[] = []
    appendActivity.mockImplementationOnce(async () => {
      callOrder.push('append')
    })
    pruneActivity.mockImplementationOnce(async () => {
      callOrder.push('prune')
    })

    await call('doc-1', '41')

    expect(callOrder).toEqual(['append', 'prune'])
  })

  it('returns the success payload with restoredFromActivityId + restoredFromTime', async () => {
    const sourceCreatedAt = new Date('2026-04-28T10:30:00Z')
    getActivityById.mockResolvedValueOnce(fakeActivityRow({
      id: 41,
      createdAt: sourceCreatedAt
    }))
    restoreDocToYjsId.mockResolvedValueOnce({
      yjsDocIdBeforeRestore: 100,
      yjsDocIdAfterRestore: 110
    })

    const result = await call('doc-1', '41')

    // The client uses `restoredFromActivityId` to highlight the source
    // row in the activity feed and `restoredFromTime` to render the
    // "Restored from N minutes ago" label on the new row. Pinning the
    // ISO format guards against a future Date→string coerce that
    // strips the milliseconds (which would invalidate the equality
    // tests on the metadata field above too).
    expect(result).toEqual({
      ok: true,
      restoredFromActivityId: 41,
      restoredFromTime: '2026-04-28T10:30:00.000Z'
    })
  })

  it('does NOT write an activity row when restoreDocToYjsId throws (atomicity)', async () => {
    // Atomicity: if the WS-side restore fails, no orphan `restore`
    // row should be left behind claiming success. The integration
    // test catches the same property end-to-end via real HTTP; this
    // pins it at the handler level so the unit suite alone is enough
    // to catch a regression that swaps the `try` block.
    getActivityById.mockResolvedValueOnce(fakeActivityRow())
    restoreDocToYjsId.mockRejectedValueOnce(new Error('WS sync timeout (10s)'))

    await expect(call('doc-1', '41'))
      .rejects.toMatchObject({ statusCode: 500 })

    expect(appendActivity).not.toHaveBeenCalled()
    expect(pruneActivity).not.toHaveBeenCalled()
  })

  it('declares write-content access on the URL document', async () => {
    // Defense-in-depth check that auth keys on the URL docId + the
    // session user id, not on the activity row's userId (which is the
    // row's AUTHOR, not the actor). A bug here would let anyone restore
    // any row whose AUTHOR was an admin, etc.
    expect(def!.access).toMatchObject({ kind: 'doc', need: 'write-content' })
    expect(def!.access).not.toHaveProperty('anonymous')
    getActivityById.mockResolvedValueOnce(fakeActivityRow({ userId: 999 }))
    restoreDocToYjsId.mockResolvedValueOnce({
      yjsDocIdBeforeRestore: 100,
      yjsDocIdAfterRestore: 110
    })

    await call('doc-x', '41')

    expect(resolveAccess).toHaveBeenCalledWith('doc-x')
    expect(getActivityById).toHaveBeenCalledWith(expect.objectContaining({ docId: 'doc-x' }), 41)
    expect(restoreDocToYjsId).toHaveBeenCalledWith(expect.objectContaining({ doc: expect.objectContaining({ docId: 'doc-x' }), actorUserId: 7 }))
  })

  it('a refused access never reaches the activity row', async () => {
    // Auth fails first → no DB roundtrip for the activity row.
    // Important because a non-member shouldn't be able to learn
    // whether activityId 41 even EXISTS on doc-1 (timing oracle).
    resolveAccess.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { statusCode: 403 }))

    await expect(call('doc-1', '41'))
      .rejects.toMatchObject({ statusCode: 403 })

    expect(getActivityById).not.toHaveBeenCalled()
    expect(restoreDocToYjsId).not.toHaveBeenCalled()
  })
})

describe('POST /api/docs/:docId/activity/:activityId/restore: plan history window', () => {
  it('refuses a row older than the document plan\'s history window BEFORE restoring', async () => {
    getActivityById.mockResolvedValueOnce(fakeActivityRow())
    assertWithinHistory.mockImplementationOnce(() => {
      const err = new Error('older than the plan history') as Error & { statusCode: number }
      err.statusCode = 409
      throw err
    })
    await expect(call('doc-1', 41)).rejects.toMatchObject({ statusCode: 409 })
    expect(resolveDocPlan).toHaveBeenCalledWith('doc-1')
    expect(assertWithinHistory).toHaveBeenCalledWith('free', new Date('2026-04-28T12:00:00Z'))
    expect(restoreDocToYjsId).not.toHaveBeenCalled()
    expect(appendActivity).not.toHaveBeenCalled()
  })
})
