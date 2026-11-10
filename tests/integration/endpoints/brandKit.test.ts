import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { TEST_BASE_URL, TEST_BILLING_OFF_BASE_URL } from '../setup/env'
import { THEME_PRESETS } from '../../../shared/utils/themePresets'

// Workspace brand kit (WP10): fonts + logos (upload checks, who may, how
// documents load them), the locked workspace design, workspace templates.

const STATIC_WOFF2 = new Uint8Array(readFileSync('node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2'))
const VARIABLE_WOFF2 = new Uint8Array(readFileSync('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'))
// 1×1 PNG.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))

type Client = Awaited<ReturnType<typeof loggedInClient>>

async function upload(client: Client, path: string, fields: Record<string, string | File>, base = TEST_BASE_URL): Promise<Response> {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return fetch(`${base}${path}`, { method: 'POST', body: form, headers: { cookie: client.cookieHeader() } })
}

const fontFile = (bytes: Uint8Array, name = 'font.woff2') => new File([bytes], name)

async function setup() {
  const admin = await createUser({ name: 'Maya Admin' })
  const ws = await createWorkspace(admin.id, { name: 'Northwind' })
  const editor = await createUser()
  await setMemberRole(ws.workspaceId, editor.id, 'editor')
  return { admin, ws, editor, adminClient: await loggedInClient(admin.id) }
}

describe('brand kit — fonts and logos', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('accepts a static font under its own name, refuses built-in names, variable fonts and missing licence', async () => {
    const { ws, adminClient } = await setup()
    const path = `/api/workspaces/${ws.workspaceId}/brand/fonts`
    // The file says "Inter" — one of markoto's built-in fonts.
    const builtIn = await upload(adminClient, path, { file: fontFile(STATIC_WOFF2), licence: 'true' })
    expect(builtIn.status).toBe(409)
    expect((await builtIn.json() as { data: { code: string } }).data.code).toBe('brand/family-built-in')
    expect((await upload(adminClient, path, { file: fontFile(STATIC_WOFF2), family: 'Acme Sans' })).status).toBe(400)
    const variable = await upload(adminClient, path, { file: fontFile(VARIABLE_WOFF2), licence: 'true', family: 'Acme Sans' })
    expect(variable.status).toBe(422)
    expect((await variable.json() as { data: { reason: string } }).data.reason).toBe('variable')
    const notAFont = await upload(adminClient, path, { file: new File(['<svg/>'], 'x.woff2'), licence: 'true', family: 'Acme Sans' })
    expect(notAFont.status).toBe(422)

    const ok = await upload(adminClient, path, { file: fontFile(STATIC_WOFF2), licence: 'true', family: 'Acme Sans' })
    expect(ok.status).toBe(201)
    expect(await ok.json()).toMatchObject({ kind: 'font', family: 'Acme Sans', weight: 400, style: 'normal', format: 'woff2' })
    const again = await upload(adminClient, path, { file: fontFile(STATIC_WOFF2), licence: 'true', family: 'Acme Sans' })
    expect(again.status).toBe(409)
    // Another weight of the same family is fine.
    expect((await upload(adminClient, path, { file: fontFile(STATIC_WOFF2), licence: 'true', family: 'Acme Sans', weight: '700' })).status).toBe(201)

    const audit = await testDb().query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'workspace.brand_asset_added' AND workspace_id = $1`, [ws.workspaceId])
    expect(audit.rows[0].n).toBe(2)
  })

  it('logos: PNG / JPEG / WebP by their bytes, never SVG', async () => {
    const { ws, adminClient } = await setup()
    const path = `/api/workspaces/${ws.workspaceId}/brand/images`
    expect((await upload(adminClient, path, { file: new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.png') })).status).toBe(415)
    const ok = await upload(adminClient, path, { file: new File([PNG], 'Northwind logo.png') })
    expect(ok.status).toBe(201)
    const body = await ok.json() as { url: string, name: string }
    expect(body.name).toBe('Northwind logo')
    expect(body.url).toMatch(/^\/api\/brand\/[A-Za-z0-9_-]{16}\.png$/)
  })

  it('only admins change the kit; members read it; markoto.app free refuses it', async () => {
    const { ws, editor } = await setup()
    const editorClient = await loggedInClient(editor.id)
    expect((await upload(editorClient, `/api/workspaces/${ws.workspaceId}/brand/images`, { file: new File([PNG], 'x.png') })).status).toBe(403)
    const kit = await editorClient.get(`/api/workspaces/${ws.workspaceId}/brand`)
    expect(kit.status).toBe(200)
    expect(await kit.json()).toMatchObject({ available: true, canManage: false, fonts: [], images: [] })
    expect((await (await loggedInClient((await createUser()).id)).get(`/api/workspaces/${ws.workspaceId}/brand`)).status).toBe(404)

    const admin2 = await createUser()
    const ws2 = await createWorkspace(admin2.id)
    const hosted = await upload(await loggedInClient(admin2.id, undefined, TEST_BILLING_OFF_BASE_URL), `/api/workspaces/${ws2.workspaceId}/brand/images`, { file: new File([PNG], 'x.png') }, TEST_BILLING_OFF_BASE_URL)
    expect(hosted.status).toBe(409)
    expect((await hosted.json() as { data: { code: string } }).data.code).toBe('plan/feature-unavailable')
  })

  it('documents load the files with the session or the file token, only from their own workspace', async () => {
    const { admin, ws, adminClient } = await setup()
    const font = await (await upload(adminClient, `/api/workspaces/${ws.workspaceId}/brand/fonts`, { file: fontFile(STATIC_WOFF2), licence: 'true', family: 'Acme Sans' })).json() as { file: string }
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    const route = `/api/docs/${doc.docId}/brand/${font.file}`

    const bySession = await adminClient.get(route)
    expect(bySession.status).toBe(200)
    expect(bySession.headers.get('content-type')).toBe('font/woff2')
    expect(bySession.headers.get('access-control-allow-origin')).toBe('*')
    expect(bySession.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    expect(new Uint8Array(await bySession.arrayBuffer())).toEqual(STATIC_WOFF2)

    // The sandboxed preview iframe: no cookie, the file-access token.
    expect((await anonClient().get(route)).status).toBe(403)
    const { token } = await (await adminClient.get(`/api/docs/${doc.docId}/file-token`)).json() as { token: string }
    expect((await anonClient().get(`${route}?token=${encodeURIComponent(token)}`)).status).toBe(200)

    // The token endpoint tells the editor which fonts to declare.
    const tokenRes = await (await adminClient.get(`/api/docs/${doc.docId}/token`)).json() as { brandKit: { fonts: Array<{ file: string, family: string }>, lockedTheme: unknown } }
    expect(tokenRes.brandKit).toEqual({ fonts: [expect.objectContaining({ file: font.file, family: 'Acme Sans' })], lockedTheme: null })

    // Another workspace's document can't reach this workspace's files.
    const other = await createWorkspace(admin.id)
    const otherDoc = await createDoc({ ownerId: admin.id, workspaceId: other.workspaceId, accessMode: 'private' })
    expect((await adminClient.get(`/api/docs/${otherDoc.docId}/brand/${font.file}`)).status).toBe(404)
    // Nor a personal document.
    const personal = await createDoc({ ownerId: admin.id, accessMode: 'private' })
    expect((await adminClient.get(`/api/docs/${personal.docId}/brand/${font.file}`)).status).toBe(404)

    // Deleting the font: gone everywhere.
    const fontId = font.file.split('.')[0]
    expect((await adminClient.delete(`/api/workspaces/${ws.workspaceId}/brand/assets/${fontId}`)).status).toBe(200)
    expect((await adminClient.get(route)).status).toBe(404)
  })
})

describe('brand kit — locked design', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('takes a document\'s design, locks it for every document, unlocks', async () => {
    const { admin, ws, editor, adminClient } = await setup()
    const lockPath = `/api/workspaces/${ws.workspaceId}/brand/lock`
    // Nothing to lock yet.
    const early = await adminClient.put(lockPath, { locked: true })
    expect(early.status).toBe(409)
    expect((await early.json() as { data: { code: string } }).data.code).toBe('brand/no-design')

    const report = THEME_PRESETS.find(p => p.id === 'business-report')!.theme
    const source = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, theme: report })
    const set = await adminClient.post(`/api/workspaces/${ws.workspaceId}/brand/design-from-doc`, { docId: source.docId })
    expect(set.status).toBe(200)
    expect((await set.json() as { defaultTheme: { body: { font: string } } }).defaultTheme.body.font).toBe(report.body.font)

    expect((await adminClient.put(lockPath, { locked: true })).status).toBe(200)
    expect((await (await loggedInClient(editor.id)).put(lockPath, { locked: false })).status).toBe(403)

    // Another document of the workspace now renders with the workspace design.
    const doc = await createDoc({ ownerId: editor.id, workspaceId: ws.workspaceId })
    const token = await (await (await loggedInClient(editor.id)).get(`/api/docs/${doc.docId}/token`)).json() as { brandKit: { lockedTheme: { body: { font: string } } | null } }
    expect(token.brandKit.lockedTheme?.body.font).toBe(report.body.font)

    expect((await adminClient.put(lockPath, { locked: false })).status).toBe(200)
    const after = await (await (await loggedInClient(editor.id)).get(`/api/docs/${doc.docId}/token`)).json() as { brandKit: { lockedTheme: unknown } }
    expect(after.brandKit.lockedTheme).toBeNull()

    const audit = await testDb().query(`SELECT after FROM audit_log WHERE action = 'workspace.brand_lock_changed' ORDER BY id`)
    expect(audit.rows.map(r => r.after)).toEqual([{ locked: true }, { locked: false }])
  })

  it('the lock pauses on a plan without the brand kit (markoto.app free)', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    await testDb().query('UPDATE workspaces SET default_theme = $2, brand_locked = true WHERE workspace_id = $1', [ws.workspaceId, JSON.stringify(THEME_PRESETS[0]!.theme)])
    const hosted = await (await (await loggedInClient(admin.id, undefined, TEST_BILLING_OFF_BASE_URL)).get(`/api/docs/${doc.docId}/token`)).json() as { brandKit: { lockedTheme: unknown } }
    expect(hosted.brandKit.lockedTheme).toBeNull()
    const selfHosted = await (await (await loggedInClient(admin.id)).get(`/api/docs/${doc.docId}/token`)).json() as { brandKit: { lockedTheme: unknown } }
    expect(selfHosted.brandKit.lockedTheme).not.toBeNull()
  })
})

describe('brand kit — workspace templates', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('admins add templates; editors make private copies of the template document', async () => {
    const { admin, ws, editor, adminClient } = await setup()
    const viewer = await createUser()
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const report = THEME_PRESETS.find(p => p.id === 'business-report')!.theme
    const source = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, accessMode: 'open-edit', title: 'Quarterly report', theme: report })

    const editorClient = await loggedInClient(editor.id)
    expect((await editorClient.post(`/api/workspaces/${ws.workspaceId}/templates`, { docId: source.docId, name: 'Report' })).status).toBe(403)
    const added = await adminClient.post(`/api/workspaces/${ws.workspaceId}/templates`, { docId: source.docId, name: 'Quarterly report', description: 'Our board report' })
    expect(added.status).toBe(201)
    const { id } = await added.json() as { id: string }
    expect((await adminClient.post(`/api/workspaces/${ws.workspaceId}/templates`, { docId: source.docId, name: 'Again' })).status).toBe(409)

    const list = await (await editorClient.get(`/api/workspaces/${ws.workspaceId}/templates`)).json() as { templates: Array<{ id: string, name: string, docTitle: string }> }
    expect(list.templates).toEqual([expect.objectContaining({ id, name: 'Quarterly report', docTitle: 'Quarterly report' })])

    const made = await editorClient.post(`/api/workspaces/${ws.workspaceId}/templates/${id}/documents`, { title: 'Q4 report' })
    expect(made.status).toBe(201)
    const { docId } = await made.json() as { docId: string }
    const row = (await testDb().query('SELECT owner_id, workspace_id, access_mode, title, theme FROM documents WHERE doc_id = $1', [docId])).rows[0]
    expect(row).toMatchObject({ owner_id: editor.id, workspace_id: ws.workspaceId, access_mode: 'private', title: 'Q4 report' })
    expect(row.theme.body.font).toBe(report.body.font)

    // Viewers can't create documents; an outsider sees nothing.
    expect((await (await loggedInClient(viewer.id)).post(`/api/workspaces/${ws.workspaceId}/templates/${id}/documents`, {})).status).toBe(403)
    expect((await (await loggedInClient((await createUser()).id)).get(`/api/workspaces/${ws.workspaceId}/templates`)).status).toBe(404)

    // Moving the template document out removes the template.
    const other = await createWorkspace(admin.id)
    expect((await adminClient.patch(`/api/docs/${source.docId}/workspace`, { workspaceId: other.workspaceId })).status).toBe(200)
    expect((await (await editorClient.get(`/api/workspaces/${ws.workspaceId}/templates`)).json() as { templates: unknown[] }).templates).toEqual([])
  })
})
