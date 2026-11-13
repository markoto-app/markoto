import { beforeEach, describe, expect, it } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { TEST_BILLING_OFF_BASE_URL } from '../setup/env'

// Workspace audit log: admins of a plan with the audit log see
// and download the workspace's events, and only that workspace's.

interface AuditEvent {
  id: number
  action: string
  actor: { id: number | null, name: string | null }
  ip: string | null
  target: { type: string, id: string | null }
}
interface Page { events: AuditEvent[], nextBefore: number | null, retentionDays: number }

async function seedEvent(wsId: string | null, action: string, opts: { actorId?: number | null, scope?: string, scopeId?: string | null, ts?: string, metadata?: unknown, before?: unknown } = {}): Promise<void> {
  await testDb().query(
    `INSERT INTO audit_log (ts, actor_user_id, actor_ip, scope, scope_id, action, workspace_id, metadata, before)
     VALUES (coalesce($1::timestamptz, now()), $2, '203.0.113.0', $3, $4, $5, $6, $7, $8)`,
    [opts.ts ?? null, opts.actorId ?? null, opts.scope ?? 'workspace', opts.scopeId ?? wsId, action, wsId, opts.metadata ? JSON.stringify(opts.metadata) : null, opts.before ? JSON.stringify(opts.before) : null]
  )
}

describe('workspace audit log', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('admins only, and only where the plan includes it', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const editor = await createUser()
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    expect((await (await loggedInClient(editor.id)).get(`/api/workspaces/${ws.workspaceId}/audit`)).status).toBe(403)
    expect((await (await loggedInClient((await createUser()).id)).get(`/api/workspaces/${ws.workspaceId}/audit`)).status).toBe(404)
    const res = await (await loggedInClient(admin.id)).get(`/api/workspaces/${ws.workspaceId}/audit`)
    expect(res.status).toBe(200)
    expect((await res.json() as Page).retentionDays).toBe(730)
    // markoto.app shape: not on the free plan.
    const hosted = await (await loggedInClient(admin.id, undefined, TEST_BILLING_OFF_BASE_URL)).get(`/api/workspaces/${ws.workspaceId}/audit`)
    expect(hosted.status).toBe(409)
    expect((await hosted.json() as { data?: { code?: string } }).data?.code).toBe('plan/feature-unavailable')
  })

  it('shows real actions of this workspace with actor name and shortened IP, never another workspace\'s', async () => {
    const admin = await createUser({ name: 'Maya Chen' })
    const ws = await createWorkspace(admin.id)
    const other = await createWorkspace(admin.id)
    const editor = await createUser()
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const client = await loggedInClient(admin.id)

    // Real writers: a role change, a sharing change on a workspace doc,
    // one in another workspace, one on a personal doc.
    expect((await client.patch(`/api/workspaces/${ws.workspaceId}/members/${editor.id}`, { role: 'viewer' })).status).toBe(200)
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    expect((await client.put(`/api/docs/${doc.docId}/meta`, { accessMode: 'open-view' })).status).toBe(200)
    const otherDoc = await createDoc({ ownerId: admin.id, workspaceId: other.workspaceId, accessMode: 'private' })
    expect((await client.put(`/api/docs/${otherDoc.docId}/meta`, { accessMode: 'open-view' })).status).toBe(200)
    const personal = await createDoc({ ownerId: admin.id, accessMode: 'private' })
    expect((await client.put(`/api/docs/${personal.docId}/meta`, { accessMode: 'open-view' })).status).toBe(200)

    const page = await (await client.get(`/api/workspaces/${ws.workspaceId}/audit`)).json() as Page
    const actions = page.events.map(e => [e.action, e.target.id])
    expect(actions).toEqual(expect.arrayContaining([['workspace.member_role_changed', ws.workspaceId], ['doc.access_mode_changed', doc.docId]]))
    expect(actions.map(a => a[1])).not.toContain(otherDoc.docId)
    expect(actions.map(a => a[1])).not.toContain(personal.docId)
    const roleChange = page.events.find(e => e.action === 'workspace.member_role_changed')!
    expect(roleChange.actor).toEqual({ id: admin.id, name: 'Maya Chen' })
    expect(roleChange.ip === null || /^[\d.]+\.0$|::$|:/.test(roleChange.ip)).toBe(true)
  })

  it('pages with a cursor and filters by kind and dates', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    for (let i = 0; i < 55; i++) await seedEvent(ws.workspaceId, 'workspace.member_removed', { actorId: admin.id })
    await seedEvent(ws.workspaceId, 'sso.sign_in', { ts: '2026-01-15T10:00:00Z' })
    const client = await loggedInClient(admin.id)

    const first = await (await client.get(`/api/workspaces/${ws.workspaceId}/audit`)).json() as Page
    expect(first.events).toHaveLength(50)
    expect(first.nextBefore).not.toBeNull()
    const second = await (await client.get(`/api/workspaces/${ws.workspaceId}/audit?before=${first.nextBefore}`)).json() as Page
    expect(second.events.length).toBeGreaterThanOrEqual(6)
    expect(new Set([...first.events, ...second.events].map(e => e.id)).size).toBe(first.events.length + second.events.length)

    const sso = await (await client.get(`/api/workspaces/${ws.workspaceId}/audit?action=sso.`)).json() as Page
    expect(sso.events.map(e => e.action)).toEqual(['sso.sign_in'])
    const jan = await (await client.get(`/api/workspaces/${ws.workspaceId}/audit?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z`)).json() as Page
    expect(jan.events.map(e => e.action)).toEqual(['sso.sign_in'])
    expect((await client.get(`/api/workspaces/${ws.workspaceId}/audit?action=x%25y`)).status).toBe(400)
  })

  it('exports CSV (spreadsheet formulas neutralised) and JSON Lines, and records the export', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await seedEvent(ws.workspaceId, 'doc.deleted', { scope: 'doc', scopeId: 'doc-1', actorId: admin.id, before: { title: '=HYPERLINK("http://evil.example","x")' } })
    const client = await loggedInClient(admin.id)

    const csv = await client.get(`/api/workspaces/${ws.workspaceId}/audit/export?format=csv`)
    expect(csv.status).toBe(200)
    expect(csv.headers.get('content-type')).toContain('text/csv')
    expect(csv.headers.get('content-disposition')).toContain('attachment')
    const text = await csv.text()
    const [header, row] = text.split('\r\n')
    expect(header).toBe('id,time,actor_id,actor_name,ip,action,target_type,target_id,before,after,details')
    expect(row).toContain('doc.deleted')
    expect(row).toContain('203.0.113.0')
    // The JSON cell starts with "{", not a formula; a bare formula value would be prefixed.
    expect(row).not.toMatch(/,=HYPERLINK/)

    const jsonl = await client.get(`/api/workspaces/${ws.workspaceId}/audit/export?format=jsonl`)
    // Newest first: the CSV download above is already in the log.
    const lines = (await jsonl.text()).trim().split('\n').map(l => JSON.parse(l) as AuditEvent)
    expect(lines.map(l => l.action)).toEqual(['workspace.audit_exported', 'doc.deleted'])

    const exported = (await testDb().query(`SELECT metadata FROM audit_log WHERE action = 'workspace.audit_exported' AND workspace_id = $1 ORDER BY id`, [ws.workspaceId])).rows
    expect(exported.map(r => r.metadata.format)).toEqual(['csv', 'jsonl'])
    expect((await client.get(`/api/workspaces/${ws.workspaceId}/audit/export?format=xml`)).status).toBe(400)
  })
})
