import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import { documents } from '../../server/db/schema'
import { useDatabase } from '../../server/db/client'
import { createDocument } from '../../server/utils/documents/createDocument'
import { asUser } from '../helpers/access'

// Pin the validate+create flow that both POST /api/docs and the
// `handleCreateDocument` AI tool handler share. The branches we care
// about: anonymous vs logged-in default access mode, workspace-role
// gating (admin/editor pass, viewer rejected, non-member rejected,
// anonymous rejected), theme-resolution precedence, and field
// validation thresholds.

describe('createDocument: happy paths', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('anonymous creation returns an open-edit doc with no owner / workspace', async () => {
    const result = await createDocument({ owner: null })
    expect(result.docId).toMatch(/^[A-Za-z0-9_-]{10}$/)
    expect(result.url).toBe(`/d/${result.docId}`)

    const db = useDatabase()
    const row = (await db.select().from(documents).where(eq(documents.docId, result.docId)))[0]!
    expect(row.ownerId).toBeNull()
    expect(row.workspaceId).toBeNull()
    expect(row.accessMode).toBe('open-edit')
  })

  it('logged-in creation defaults to private + sets ownerId', async () => {
    const user = await createUser()
    const result = await createDocument({ owner: asUser(user.id) })

    const db = useDatabase()
    const row = (await db.select().from(documents).where(eq(documents.docId, result.docId)))[0]!
    expect(row.ownerId).toBe(user.id)
    expect(row.accessMode).toBe('private')
    expect(row.workspaceId).toBeNull()
  })

  it('files into a workspace when caller is admin/editor', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const result = await createDocument({
      owner: asUser(owner.id),
      workspaceId: ws.workspaceId,
      title: 'Q3 retro'
    })

    const db = useDatabase()
    const row = (await db.select().from(documents).where(eq(documents.docId, result.docId)))[0]!
    expect(row.workspaceId).toBe(ws.workspaceId)
    expect(row.title).toBe('Q3 retro')
  })

  it('optional context fields land on the row', async () => {
    const user = await createUser()
    const result = await createDocument({
      owner: asUser(user.id),
      title: '  trimmed  ',
      description: 'Hello world',
      audience: 'casual',
      language: 'Deutsch'
    })

    const db = useDatabase()
    const row = (await db.select().from(documents).where(eq(documents.docId, result.docId)))[0]!
    expect(row.title).toBe('trimmed')
    expect(row.description).toBe('Hello world')
    expect(row.audience).toBe('casual')
    expect(row.language).toBe('Deutsch')
  })
})

describe('createDocument: workspace authz gating', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('anonymous + workspace_id → 401', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    await expect(createDocument({
      owner: null,
      workspaceId: ws.workspaceId
    })).rejects.toMatchObject({ statusCode: 401 })
  })

  it('non-member + workspace_id → 403', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const stranger = await createUser()
    await expect(createDocument({
      owner: asUser(stranger.id),
      workspaceId: ws.workspaceId
    })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('viewer + workspace_id → 403', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const viewer = await createUser()
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    await expect(createDocument({
      owner: asUser(viewer.id),
      workspaceId: ws.workspaceId
    })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('editor + workspace_id → success', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const editor = await createUser()
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const result = await createDocument({
      owner: asUser(editor.id),
      workspaceId: ws.workspaceId
    })
    const db = useDatabase()
    const row = (await db.select().from(documents).where(eq(documents.docId, result.docId)))[0]!
    expect(row.ownerId).toBe(editor.id)
    expect(row.workspaceId).toBe(ws.workspaceId)
  })
})

describe('createDocument: validation', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('rejects title > 255 chars', async () => {
    const user = await createUser()
    await expect(createDocument({
      owner: asUser(user.id),
      title: 'x'.repeat(256)
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects description > 500 chars', async () => {
    const user = await createUser()
    await expect(createDocument({
      owner: asUser(user.id),
      description: 'x'.repeat(501)
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects empty language string', async () => {
    const user = await createUser()
    await expect(createDocument({
      owner: asUser(user.id),
      language: '   '
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects unknown templateId', async () => {
    const user = await createUser()
    await expect(createDocument({
      owner: asUser(user.id),
      templateId: 'definitely-not-a-template'
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects unknown themePreset', async () => {
    const user = await createUser()
    await expect(createDocument({
      owner: asUser(user.id),
      themePreset: 'definitely-not-a-preset'
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects themeId AND themePreset together (mutex)', async () => {
    const user = await createUser()
    await expect(createDocument({
      owner: asUser(user.id),
      themeId: 'foo',
      themePreset: 'modern'
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('themeId from another user → 404 (cross-user theme application blocked)', async () => {
    const owner = await createUser()
    const otherUser = await createUser()
    // Create a saved theme for owner via direct insert
    const tdb = testDb()
    await tdb.query(
      `INSERT INTO themes (theme_id, user_id, name, theme) VALUES ($1, $2, $3, $4)`,
      ['t-shared', owner.id, 'Owner theme', JSON.stringify({})]
    )
    await expect(createDocument({
      owner: asUser(otherUser.id),
      themeId: 't-shared'
    })).rejects.toMatchObject({ statusCode: 404 })
  })
})
