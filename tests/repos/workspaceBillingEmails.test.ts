import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'

// Who gets a Team / Business billing email, and that a once-key holds
// (real Postgres + Valkey; the mail transport is mocked).

const sent = vi.fn(async (_args: { to: string | null, subject: string, locale: string | null }) => ({ delivered: true }))
vi.mock('../../server/utils/email/sendEmail', () => ({ safeSendTransactionalEmail: sent }))
vi.stubGlobal('useRuntimeConfig', () => ({ siteUrl: 'https://markoto.app' }))

const { notifyWorkspaceAdmins } = await import('../../server/utils/email/workspaceBillingEmails')

describe('notifyWorkspaceAdmins', () => {
  beforeEach(async () => {
    await resetDb()
    sent.mockClear()
  })

  async function workspaceWithPeople() {
    const maya = await createUser()
    const ben = await createUser()
    const lena = await createUser()
    await testDb().query(`UPDATE users SET email = 'maya@x.test', locale = 'de' WHERE id = $1`, [maya.id])
    await testDb().query(`UPDATE users SET email = 'ben@x.test' WHERE id = $1`, [ben.id])
    await testDb().query(`UPDATE users SET email = 'lena@x.test' WHERE id = $1`, [lena.id])
    const ws = await createWorkspace(maya.id, { name: 'Northwind' })
    await setMemberRole(ws.workspaceId, ben.id, 'admin')
    await setMemberRole(ws.workspaceId, lena.id, 'editor')
    return { ws, maya, ben, lena }
  }

  it('mails every admin in their language, never an editor, with the billing link', async () => {
    const { ws } = await workspaceWithPeople()
    expect(await notifyWorkspaceAdmins({ workspaceId: ws.workspaceId, kind: 'payment_failed' })).toBe(2)
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2))
    const to = sent.mock.calls.map(c => c[0].to).sort()
    expect(to).toEqual(['ben@x.test', 'maya@x.test'])
    const maya = sent.mock.calls.find(c => c[0].to === 'maya@x.test')![0] as unknown as { locale: string, subject: string, body: string }
    expect(maya.locale).toBe('de')
    expect(maya.subject).toContain('Zahlung')
    expect(maya.body).toContain(`https://markoto.app/w/${ws.workspaceId}?tab=billing`)
  })

  it('onlyUserIds / excludeUserIds narrow the recipients', async () => {
    const { ws, maya, ben } = await workspaceWithPeople()
    expect(await notifyWorkspaceAdmins({ workspaceId: ws.workspaceId, kind: 'seat_added', onlyUserIds: [maya.id], excludeUserIds: [ben.id], vars: { seats: 4, actor: 'Ben' } })).toBe(1)
  })

  it('a once-key sends at most once', async () => {
    const { ws } = await workspaceWithPeople()
    const onceKey = `test:${randomBytes(6).toString('hex')}`
    expect(await notifyWorkspaceAdmins({ workspaceId: ws.workspaceId, kind: 'budget_80', onceKey })).toBe(2)
    expect(await notifyWorkspaceAdmins({ workspaceId: ws.workspaceId, kind: 'budget_80', onceKey })).toBe(0)
  })
})
