import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'

// End-to-end coverage for audit-log instrumentation across the six
// security-sensitive action sites. Each test performs the action via the
// HTTP API and asserts the audit row landed with the expected shape.
//
// We query the DB directly (not via the repo) because the integration
// tests run the API as a separate Bun subprocess — we want to assert
// what made it to the audit table, not what `getAuditEventsByScope`
// chose to return.

interface AuditRow {
  id: number
  ts: Date
  actor_user_id: number | null
  actor_ip: string | null
  scope: string
  scope_id: string | null
  action: string
  before: unknown
  after: unknown
  metadata: Record<string, unknown> | null
}

async function readAudit(scope: string, scopeId: string): Promise<AuditRow[]> {
  const db = testDb()
  const r = await db.query<AuditRow>(
    'SELECT * FROM audit_log WHERE scope = $1 AND scope_id = $2 ORDER BY id ASC',
    [scope, scopeId]
  )
  return r.rows
}

describe('audit log — doc.deleted (B1)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('records doc deletion with snapshot + reason=user_initiated', async () => {
    const owner = await createUser()
    const doc = await createDoc({
      ownerId: owner.id,
      accessMode: 'private',
      title: 'Doomed Doc'
    })
    const client = await loggedInClient(owner.id)
    const res = await client.delete(`/api/docs/${doc.docId}`)
    expect(res.status).toBe(200)

    const rows = await readAudit('doc', doc.docId)
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('doc.deleted')
    expect(rows[0].actor_user_id).toBe(owner.id)
    expect(rows[0].before).toMatchObject({
      title: 'Doomed Doc',
      accessMode: 'private',
      ownerId: owner.id
    })
    expect(rows[0].after).toBeNull()
    expect(rows[0].metadata).toMatchObject({ reason: 'user_initiated' })
  })

  it('records workspace_cascade reason for each child doc when workspace is deleted', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const doc1 = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, title: 'A' })
    const doc2 = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, title: 'B' })
    const client = await loggedInClient(admin.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}`)
    expect(res.status).toBe(200)

    const rows1 = await readAudit('doc', doc1.docId)
    expect(rows1).toHaveLength(1)
    expect((rows1[0].metadata as { reason: string }).reason).toBe('workspace_cascade')
    const rows2 = await readAudit('doc', doc2.docId)
    expect(rows2).toHaveLength(1)
    expect((rows2[0].metadata as { reason: string }).reason).toBe('workspace_cascade')

    // Plus the workspace.deleted row itself.
    const wsRows = await readAudit('workspace', ws.workspaceId)
    expect(wsRows).toHaveLength(1)
    expect(wsRows[0].action).toBe('workspace.deleted')
  })
})

describe('audit log — doc.password_set / password_removed (B2)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('records doc.password_set without the password value', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const client = await loggedInClient(owner.id)
    const res = await client.post(`/api/docs/${doc.docId}/password`, {
      action: 'set',
      password: 'super-secret-password'
    })
    expect(res.status).toBe(200)

    const rows = await readAudit('doc', doc.docId)
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('doc.password_set')
    expect(rows[0].after).toMatchObject({ accessMode: 'password-protected', hasPassword: true })
    // The password must NEVER appear anywhere in the audit row.
    const serialized = JSON.stringify(rows[0])
    expect(serialized).not.toContain('super-secret-password')
  })

  it('records doc.password_removed with hasPassword=false in after', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const client = await loggedInClient(owner.id)
    await client.post(`/api/docs/${doc.docId}/password`, {
      action: 'set',
      password: 'pw123456'
    })
    const res = await client.post(`/api/docs/${doc.docId}/password`, { action: 'remove' })
    expect(res.status).toBe(200)

    const rows = await readAudit('doc', doc.docId)
    expect(rows).toHaveLength(2)
    expect(rows[1].action).toBe('doc.password_removed')
    expect(rows[1].after).toMatchObject({ accessMode: 'open-edit', hasPassword: false })
  })
})

describe('audit log — doc.access_mode_changed (B3)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('records access_mode change with before/after', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const client = await loggedInClient(owner.id)
    const res = await client.put(`/api/docs/${doc.docId}/meta`, { accessMode: 'open-edit' })
    expect(res.status).toBe(200)

    const rows = await readAudit('doc', doc.docId)
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('doc.access_mode_changed')
    expect(rows[0].before).toEqual({ accessMode: 'private' })
    expect(rows[0].after).toEqual({ accessMode: 'open-edit' })
  })

  it('does NOT record an audit row when accessMode is not changing', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const client = await loggedInClient(owner.id)
    // Title-only update should not produce an audit row.
    await client.put(`/api/docs/${doc.docId}/meta`, { title: 'New title' })
    const rows = await readAudit('doc', doc.docId)
    expect(rows).toHaveLength(0)
  })
})

describe('audit log — doc.workspace_moved (B4)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('records workspace move with before/after workspace ids', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const client = await loggedInClient(owner.id)
    const res = await client.patch(`/api/docs/${doc.docId}/workspace`, { workspaceId: ws.workspaceId })
    expect(res.status).toBe(200)

    const rows = await readAudit('doc', doc.docId)
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('doc.workspace_moved')
    expect(rows[0].before).toEqual({ workspaceId: null })
    expect(rows[0].after).toEqual({ workspaceId: ws.workspaceId })
  })
})

describe('audit log — workspace.member_removed (B5)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('records member removal with prior role + affectedUserId', async () => {
    const admin = await createUser()
    const member = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    const client = await loggedInClient(admin.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}/members/${member.id}`)
    expect(res.status).toBe(200)

    const rows = await readAudit('workspace', ws.workspaceId)
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('workspace.member_removed')
    expect(rows[0].actor_user_id).toBe(admin.id)
    expect(rows[0].before).toEqual({ role: 'editor' })
    expect(rows[0].after).toBeNull()
    expect(rows[0].metadata).toMatchObject({
      affectedUserId: member.id,
      workspaceId: ws.workspaceId,
      isSelf: false
    })
  })
})

describe('audit log — workspace.member_role_changed (B6)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('records role change with before/after role', async () => {
    const admin = await createUser()
    const member = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    const client = await loggedInClient(admin.id)
    const res = await client.patch(
      `/api/workspaces/${ws.workspaceId}/members/${member.id}`,
      { role: 'admin' }
    )
    expect(res.status).toBe(200)

    const rows = await readAudit('workspace', ws.workspaceId)
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('workspace.member_role_changed')
    expect(rows[0].before).toEqual({ role: 'editor' })
    expect(rows[0].after).toEqual({ role: 'admin' })
    expect(rows[0].metadata).toMatchObject({
      affectedUserId: member.id,
      workspaceId: ws.workspaceId
    })
  })

  it('does not write an audit row on a no-op role patch', async () => {
    const admin = await createUser()
    const member = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    const client = await loggedInClient(admin.id)
    const res = await client.patch(
      `/api/workspaces/${ws.workspaceId}/members/${member.id}`,
      { role: 'editor' }
    )
    expect(res.status).toBe(200)

    const rows = await readAudit('workspace', ws.workspaceId)
    expect(rows).toHaveLength(0)
  })
})
