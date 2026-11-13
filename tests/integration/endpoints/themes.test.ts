import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import { THEME_PRESETS } from '~~/shared/utils/theme/themePresets'
import { first } from '../../helpers/assert'

// /api/themes: user-saved theme presets.
// Plus the workspace `defaultTheme` field (PUT /api/workspaces/:id) and
// the seed-from-workspace-default behaviour of POST /api/docs.

const TINY_THEME = defaultTheme

async function readWorkspaceTheme(wsId: string) {
  const db = testDb()
  const r = await db.query<{ default_theme: unknown | null }>(
    'SELECT default_theme FROM workspaces WHERE workspace_id = $1',
    [wsId]
  )
  return r.rows[0]?.default_theme ?? null
}

async function readDocTheme(docId: string) {
  const db = testDb()
  const r = await db.query<{ theme: { color?: { brand?: string } } | null }>(
    'SELECT theme FROM documents WHERE doc_id = $1',
    [docId]
  )
  return r.rows[0]?.theme ?? null
}

describe('GET /api/themes: list', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('rejects anonymous callers with 401', async () => {
    const res = await anonClient().get('/api/themes')
    expect(res.status).toBe(401)
  })

  it('returns an empty list for a logged-in user with no saved themes', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const res = await client.get('/api/themes')
    expect(res.status).toBe(200)
    const body = await res.json() as { themes: unknown[] }
    expect(body.themes).toEqual([])
  })

  it('only lists themes belonging to the caller', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    // Seed via POST so the round-trip exercises the create handler too.
    const ownerClient = await loggedInClient(owner.id)
    await ownerClient.post('/api/themes', { name: 'Mine', theme: TINY_THEME })
    const strangerClient = await loggedInClient(stranger.id)
    const res = await strangerClient.get('/api/themes')
    expect(res.status).toBe(200)
    const body = await res.json() as { themes: unknown[] }
    expect(body.themes).toHaveLength(0)
  })
})

describe('POST /api/themes: create', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('rejects anonymous callers with 401', async () => {
    const res = await anonClient().post('/api/themes', { name: 'X', theme: TINY_THEME })
    expect(res.status).toBe(401)
  })

  it('saves a theme + returns the new id', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/themes', { name: 'Red brand', theme: TINY_THEME })
    expect(res.status).toBe(200)
    const body = await res.json() as { themeId: string, name: string }
    expect(body.name).toBe('Red brand')
    expect(typeof body.themeId).toBe('string')
  })

  it('rejects an empty name with 400', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/themes', { name: '   ', theme: TINY_THEME })
    expect(res.status).toBe(400)
  })

  it('rejects an invalid theme payload with 400', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/themes', {
      name: 'X',
      theme: { not: 'a theme' }
    })
    expect(res.status).toBe(400)
  })

  it('caps saved themes at 20 per user (409 on the 21st)', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    for (let i = 0; i < 20; i++) {
      const res = await client.post('/api/themes', { name: `t${i}`, theme: TINY_THEME })
      expect(res.status).toBe(200)
    }
    const overflow = await client.post('/api/themes', { name: 't21', theme: TINY_THEME })
    expect(overflow.status).toBe(409)
  })
})

describe('PATCH /api/themes/:themeId: rename / replace', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('renames a theme owned by the caller', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const created = await (await client.post('/api/themes', { name: 'A', theme: TINY_THEME })).json() as { themeId: string }
    const res = await client.patch(`/api/themes/${created.themeId}`, { name: 'B' })
    expect(res.status).toBe(200)
    const list = await (await client.get('/api/themes')).json() as { themes: Array<{ name: string }> }
    expect(first(list.themes).name).toBe('B')
  })

  it('returns 404 when the theme belongs to another user', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const ownerClient = await loggedInClient(owner.id)
    const created = await (await ownerClient.post('/api/themes', { name: 'A', theme: TINY_THEME })).json() as { themeId: string }
    const strangerClient = await loggedInClient(stranger.id)
    const res = await strangerClient.patch(`/api/themes/${created.themeId}`, { name: 'Stolen' })
    expect(res.status).toBe(404)
  })

  it('rejects an empty body with 400', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const created = await (await client.post('/api/themes', { name: 'A', theme: TINY_THEME })).json() as { themeId: string }
    const res = await client.patch(`/api/themes/${created.themeId}`, {})
    expect(res.status).toBe(400)
  })
})

describe('saved theme descriptions', () => {
  beforeEach(async () => {
    await resetDb()
  })

  type Listed = { themes: Array<{ themeId: string, name: string, description: string }> }

  it('stores an optional description on create (trimmed) and lists it', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/themes', { name: '  Paper  ', description: '  Two columns, serif.  ', theme: TINY_THEME })
    expect(res.status).toBe(200)
    const created = await res.json() as { name: string, description: string }
    expect(created).toMatchObject({ name: 'Paper', description: 'Two columns, serif.' })
    const plain = await client.post('/api/themes', { name: 'Plain', theme: TINY_THEME })
    expect((await plain.json() as { description: string }).description).toBe('')
    const list = await (await client.get('/api/themes')).json() as Listed
    expect(list.themes.map(t => t.description).sort()).toEqual(['', 'Two columns, serif.'])
  })

  it('edits name and description without touching the theme', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const created = await (await client.post('/api/themes', { name: 'A', theme: TINY_THEME })).json() as { themeId: string }
    const res = await client.patch(`/api/themes/${created.themeId}`, { name: 'B', description: 'For reports' })
    expect(res.status).toBe(200)
    const list = await (await client.get('/api/themes')).json() as Listed & { themes: Array<{ theme: unknown }> }
    expect(list.themes[0]).toMatchObject({ name: 'B', description: 'For reports' })
    expect(list.themes[0]!.theme).toEqual(TINY_THEME)
    // Clearing the description is allowed.
    expect((await client.patch(`/api/themes/${created.themeId}`, { description: '' })).status).toBe(200)
    const cleared = await (await client.get('/api/themes')).json() as Listed
    expect(cleared.themes[0]!.description).toBe('')
  })

  it('enforces the shared limits (name 80, description 200) on create and edit', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const longName = await client.post('/api/themes', { name: 'n'.repeat(81), theme: TINY_THEME })
    expect(longName.status).toBe(400)
    expect((await longName.json() as { data: { code: string } }).data.code).toBe('theme/name-too-long')
    const longDescription = await client.post('/api/themes', { name: 'ok', description: 'd'.repeat(201), theme: TINY_THEME })
    expect(longDescription.status).toBe(400)
    expect((await longDescription.json() as { data: { code: string } }).data.code).toBe('theme/description-too-long')
    expect((await client.post('/api/themes', { name: 'ok', description: 42, theme: TINY_THEME })).status).toBe(400)
    const okAtLimit = await client.post('/api/themes', { name: 'n'.repeat(80), description: 'd'.repeat(200), theme: TINY_THEME })
    expect(okAtLimit.status).toBe(200)
    const { themeId } = await okAtLimit.json() as { themeId: string }
    expect((await client.patch(`/api/themes/${themeId}`, { description: 'd'.repeat(201) })).status).toBe(400)
    expect((await client.patch(`/api/themes/${themeId}`, { name: '   ' })).status).toBe(400)
  })
})

describe('DELETE /api/themes/:themeId', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('deletes a theme owned by the caller', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const created = await (await client.post('/api/themes', { name: 'A', theme: TINY_THEME })).json() as { themeId: string }
    const res = await client.delete(`/api/themes/${created.themeId}`)
    expect(res.status).toBe(200)
    const list = await (await client.get('/api/themes')).json() as { themes: unknown[] }
    expect(list.themes).toHaveLength(0)
  })

  it('returns 404 for another user\'s id (no leak via 403)', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const ownerClient = await loggedInClient(owner.id)
    const created = await (await ownerClient.post('/api/themes', { name: 'A', theme: TINY_THEME })).json() as { themeId: string }
    const strangerClient = await loggedInClient(stranger.id)
    const res = await strangerClient.delete(`/api/themes/${created.themeId}`)
    expect(res.status).toBe(404)
  })
})

describe('PUT /api/workspaces/:wsId: defaultTheme', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('admin can set the workspace default theme', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, admin.id, 'admin')
    const client = await loggedInClient(admin.id)
    const res = await client.put(`/api/workspaces/${ws.workspaceId}`, {
      defaultTheme: TINY_THEME
    })
    expect(res.status).toBe(200)
    const stored = await readWorkspaceTheme(ws.workspaceId)
    expect(stored).toEqual(TINY_THEME)
  })

  it('admin can clear the workspace default theme by passing null', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, admin.id, 'admin')
    const client = await loggedInClient(admin.id)
    await client.put(`/api/workspaces/${ws.workspaceId}`, { defaultTheme: TINY_THEME })
    const cleared = await client.put(`/api/workspaces/${ws.workspaceId}`, { defaultTheme: null })
    expect(cleared.status).toBe(200)
    expect(await readWorkspaceTheme(ws.workspaceId)).toBeNull()
  })

  it('editor cannot change the workspace default theme (403)', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, admin.id, 'admin')
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const client = await loggedInClient(editor.id)
    const res = await client.put(`/api/workspaces/${ws.workspaceId}`, {
      defaultTheme: TINY_THEME
    })
    expect(res.status).toBe(403)
  })

  it('rejects a malformed defaultTheme with 400', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, admin.id, 'admin')
    const client = await loggedInClient(admin.id)
    const res = await client.put(`/api/workspaces/${ws.workspaceId}`, {
      defaultTheme: { color: { brand: 'red; }' } } // missing fields + bad hex
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/docs: theme resolution order', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('seeds with the workspace default when no themePreset/themeId is supplied', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, admin.id, 'admin')
    const adminClient = await loggedInClient(admin.id)
    const arxiv = THEME_PRESETS.find(p => p.id === 'arxiv')!
    await adminClient.put(`/api/workspaces/${ws.workspaceId}`, {
      defaultTheme: arxiv.theme
    })
    const res = await adminClient.post('/api/docs', { workspaceId: ws.workspaceId })
    expect(res.status).toBe(200)
    const { docId } = await res.json() as { docId: string }
    const stored = await readDocTheme(docId)
    expect(stored).toEqual(arxiv.theme)
  })

  it('themePreset takes precedence over the workspace default', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, admin.id, 'admin')
    const adminClient = await loggedInClient(admin.id)
    const arxiv = THEME_PRESETS.find(p => p.id === 'arxiv')!
    const thesis = THEME_PRESETS.find(p => p.id === 'thesis')!
    await adminClient.put(`/api/workspaces/${ws.workspaceId}`, { defaultTheme: arxiv.theme })
    const res = await adminClient.post('/api/docs', {
      workspaceId: ws.workspaceId,
      themePreset: 'thesis'
    })
    const { docId } = await res.json() as { docId: string }
    expect(await readDocTheme(docId)).toEqual(thesis.theme)
  })

  it('saved themeId resolves to that theme for the owner', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const arxiv = THEME_PRESETS.find(p => p.id === 'arxiv')!
    const created = await (await client.post('/api/themes', {
      name: 'Saved-arXiv',
      theme: arxiv.theme
    })).json() as { themeId: string }
    const res = await client.post('/api/docs', { themeId: created.themeId })
    expect(res.status).toBe(200)
    const { docId } = await res.json() as { docId: string }
    expect(await readDocTheme(docId)).toEqual(arxiv.theme)
  })

  it('rejects passing both themePreset AND themeId with 400', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const created = await (await client.post('/api/themes', {
      name: 'X', theme: TINY_THEME
    })).json() as { themeId: string }
    const res = await client.post('/api/docs', {
      themePreset: 'modern',
      themeId: created.themeId
    })
    expect(res.status).toBe(400)
  })

  it('rejects another user\'s themeId with 404', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const ownerClient = await loggedInClient(owner.id)
    const created = await (await ownerClient.post('/api/themes', {
      name: 'Mine', theme: TINY_THEME
    })).json() as { themeId: string }
    const strangerClient = await loggedInClient(stranger.id)
    const res = await strangerClient.post('/api/docs', { themeId: created.themeId })
    expect(res.status).toBe(404)
  })

  it('changing the workspace default does NOT retheme existing docs (snapshot semantics)', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, admin.id, 'admin')
    const adminClient = await loggedInClient(admin.id)
    const arxiv = THEME_PRESETS.find(p => p.id === 'arxiv')!
    const thesis = THEME_PRESETS.find(p => p.id === 'thesis')!

    await adminClient.put(`/api/workspaces/${ws.workspaceId}`, { defaultTheme: arxiv.theme })
    const { docId } = await (await adminClient.post('/api/docs', {
      workspaceId: ws.workspaceId
    })).json() as { docId: string }
    expect(await readDocTheme(docId)).toEqual(arxiv.theme)

    // Change workspace default. Existing doc must keep arxiv.
    await adminClient.put(`/api/workspaces/${ws.workspaceId}`, { defaultTheme: thesis.theme })
    expect(await readDocTheme(docId)).toEqual(arxiv.theme)
  })
})

describe('GET /api/workspaces/:wsId: defaultTheme surfaced', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns defaultTheme=null when not set', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, admin.id, 'admin')
    const client = await loggedInClient(admin.id)
    const res = await client.get(`/api/workspaces/${ws.workspaceId}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { workspace: { defaultTheme: unknown | null } }
    expect(body.workspace.defaultTheme).toBeNull()
  })

  it('returns the configured defaultTheme to all members', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, admin.id, 'admin')
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const adminClient = await loggedInClient(admin.id)
    await adminClient.put(`/api/workspaces/${ws.workspaceId}`, { defaultTheme: TINY_THEME })
    const editorClient = await loggedInClient(editor.id)
    const res = await editorClient.get(`/api/workspaces/${ws.workspaceId}`)
    const body = await res.json() as { workspace: { defaultTheme: unknown } }
    expect(body.workspace.defaultTheme).toEqual(TINY_THEME)
  })
})
