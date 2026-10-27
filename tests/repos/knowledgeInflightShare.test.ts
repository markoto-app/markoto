import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { nanoid } from 'nanoid'
import { resetDb } from '../integration/setup/db'
import { createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import { DEFAULT_TIERS } from '../../shared/config/tiers'

// Regression: the per-workspace inflight-upload counter was shared by all
// members, so one editor requesting presigns (and never confirming) could
// hold every slot and lock everyone else out of uploading. Each member may
// now hold at most half of the workspace's free slots.
//
// Real Valkey: the repos tier runs with TEST_MODE=1 (which bypasses the
// limiters) — switched off for this file, like rateLimitAtomic.test.ts.

class HttpError extends Error {
  statusCode: number
  constructor(opts: { statusCode: number, message: string }) {
    super(opts.message)
    this.statusCode = opts.statusCode
  }
}
vi.stubGlobal('createError', (opts: { statusCode: number, message: string }) => new HttpError(opts))

const { reserveUploadSlot, memberShareOfWorkspaceSlots } = await import('../../server/utils/knowledgeQuota')

let savedTestMode: string | undefined
beforeAll(() => {
  savedTestMode = process.env.TEST_MODE
  delete process.env.TEST_MODE
})
afterAll(() => {
  if (savedTestMode === undefined) delete process.env.TEST_MODE
  else process.env.TEST_MODE = savedTestMode
})

describe('knowledge upload slots: per-member share of the workspace', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('one member cannot hold all of a workspace\'s slots; another member still can upload', async () => {
    const admin = await createUser()
    const editor = await createUser()
    // Fresh workspace id per run: the Valkey counters outlive resetDb().
    const ws = await createWorkspace(admin.id, { workspaceId: `ws-share-${nanoid(8)}` })
    await setMemberRole(ws.workspaceId, editor.id, 'editor')

    const slots = DEFAULT_TIERS.free.knowledgeFiles
    const share = memberShareOfWorkspaceSlots(slots)
    expect(share).toBeLessThan(slots)

    const held: Array<{ releaseSlots: () => Promise<void> }> = []
    try {
      for (let i = 0; i < share; i++) {
        held.push(await reserveUploadSlot({ workspaceId: ws.workspaceId, userId: admin.id, size: 10 }))
      }
      await expect(reserveUploadSlot({ workspaceId: ws.workspaceId, userId: admin.id, size: 10 }))
        .rejects.toMatchObject({ statusCode: 409 })

      held.push(await reserveUploadSlot({ workspaceId: ws.workspaceId, userId: editor.id, size: 10 }))
    } finally {
      for (const h of held) await h.releaseSlots()
    }

    // Released slots are usable again.
    const again = await reserveUploadSlot({ workspaceId: ws.workspaceId, userId: admin.id, size: 10 })
    await again.releaseSlots()
  })
})
