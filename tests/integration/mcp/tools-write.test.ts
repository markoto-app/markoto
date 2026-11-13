import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { resetDb, testDb } from '../setup/db'
import { createDoc, createUser } from '../setup/fixtures'
import { mcp, mintPat } from '../setup/mcpClient'

// Documents:write tools: verify the mutation lands in BOTH the Y.js
// state (durable, via sync-test → yjs_updates) AND the activity_log
// row tagged with `mcp:{sessionId}` actor_principal. The audit-chain
// resolution (mcp:{sessionId} → mcp_sessions.user_id) is pinned in
// audit-and-session.test.ts; this file asserts side-effect presence.

async function seedYjs(docname: string, body: string): Promise<void> {
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, body)
  const update = Y.encodeStateAsUpdate(ydoc)
  await testDb().query(
    `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', $2)`,
    [docname, Buffer.from(update)]
  )
}

async function readYtext(docname: string): Promise<string> {
  // Replay every yjs_updates row for this docname to reconstruct
  // current state. The MCP write goes through Hocuspocus → y-postgresql
  // append, which produces a fresh row per transact() call.
  const r = await testDb().query<{ value: Buffer }>(
    `SELECT data AS value FROM yjs_updates WHERE doc_id = $1 ORDER BY id`,
    [docname]
  )
  const ydoc = new Y.Doc()
  for (const row of r.rows) {
    Y.applyUpdate(ydoc, new Uint8Array(row.value))
  }
  return ydoc.getText('content').toString()
}

async function activityRowsForDoc(docId: string): Promise<Array<{
  action: string
  user_id: number | null
  actor_principal: string | null
}>> {
  const r = await testDb().query<{ action: string, user_id: number | null, actor_principal: string | null }>(
    `SELECT action, user_id, actor_principal FROM activity_log WHERE doc_id = $1 ORDER BY id DESC`,
    [docId]
  )
  return r.rows
}

const WRITE_SCOPES = ['documents:read', 'documents:write'] as const

describe('MCP write tools: replace_text', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('mutates the Y.js state', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    await seedYjs(doc.docId, 'one apple\ntwo pears')

    const { plaintext } = await mintPat({ userId: user.id, scopes: WRITE_SCOPES })
    const res = await mcp(plaintext).call('replace_text', {
      doc_id: doc.docId,
      old_str: 'apple',
      new_str: 'orange'
    })
    expect(res.isError).not.toBe(true)

    // Hocuspocus debounces 2s before flushing, wait for the write to land.
    await new Promise(r => setTimeout(r, 2500))

    const ytext = await readYtext(doc.docId)
    expect(ytext).toContain('one orange')
    expect(ytext).not.toContain('one apple')
  }, 15_000)

  it('reports "0 matches" cleanly when old_str is not present', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    await seedYjs(doc.docId, 'hello world')

    const { plaintext } = await mintPat({ userId: user.id, scopes: WRITE_SCOPES })
    const res = await mcp(plaintext).call('replace_text', {
      doc_id: doc.docId,
      old_str: 'nonexistent string',
      new_str: 'whatever'
    })
    // Tool surfaces the mismatch as isError:true with a "no match" text.
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/match|not found|0/i)
    })
  })
})

describe('MCP write tools: insert_text', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('inserts at the requested 1-indexed line', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    await seedYjs(doc.docId, 'line one\nline two\n')

    const { plaintext } = await mintPat({ userId: user.id, scopes: WRITE_SCOPES })
    const res = await mcp(plaintext).call('insert_text', {
      doc_id: doc.docId,
      insert_line: 1,
      insert_text: 'INJECTED\n'
    })
    expect(res.isError).not.toBe(true)

    await new Promise(r => setTimeout(r, 2500))
    const ytext = await readYtext(doc.docId)
    expect(ytext).toContain('INJECTED')
  }, 15_000)
})

describe('MCP write tools: set_title + update_theme persist to documents row', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('set_title updates documents.title', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, title: 'Original' })

    const { plaintext } = await mintPat({ userId: user.id, scopes: WRITE_SCOPES })
    const res = await mcp(plaintext).call('set_title', {
      doc_id: doc.docId,
      title: 'Renamed via MCP'
    })
    expect(res.isError).not.toBe(true)

    await new Promise(r => setTimeout(r, 2500))
    const r2 = await testDb().query<{ title: string }>(
      `SELECT title FROM documents WHERE doc_id = $1`, [doc.docId]
    )
    expect(r2.rows[0]?.title).toBe('Renamed via MCP')
  }, 15_000)

  it('update_theme writes the partial theme into documents.theme', async () => {
    // Use a narrow patch (single body color) instead of a preset swap.
    // Preset swaps replace the base theme wholesale, which can fail
    // validation if the seed doc's stored theme + the preset's missing
    // fields don't merge into a complete shape. A scalar patch is a
    // happy-path that exercises persistence without the validator
    // edge case.
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })

    const { plaintext } = await mintPat({ userId: user.id, scopes: WRITE_SCOPES })
    const res = await mcp(plaintext).call('update_theme', {
      doc_id: doc.docId,
      page: { margin: 30 }
    })
    if (res.isError) {
      const errText = res.content.find(c => c.type === 'text')?.text ?? '(no text)'
      throw new Error(`update_theme returned isError: ${errText}`)
    }

    await new Promise(r => setTimeout(r, 2500))
    const r2 = await testDb().query<{ theme: { page?: { margin?: number } } }>(
      `SELECT theme FROM documents WHERE doc_id = $1`, [doc.docId]
    )
    expect(r2.rows[0]?.theme?.page?.margin).toBe(30)
  }, 15_000)

  it('update_theme stores valid customCss verbatim', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    const css = '.paged-doc h1 {\n  color: #123456;\n}\n'

    const { plaintext } = await mintPat({ userId: user.id, scopes: WRITE_SCOPES })
    const res = await mcp(plaintext).call('update_theme', { doc_id: doc.docId, customCss: css })
    if (res.isError) {
      throw new Error(`update_theme returned isError: ${res.content.find(c => c.type === 'text')?.text ?? '(no text)'}`)
    }

    await new Promise(r => setTimeout(r, 2500))
    const r2 = await testDb().query<{ theme: { customCss?: string } }>(
      `SELECT theme FROM documents WHERE doc_id = $1`, [doc.docId]
    )
    expect(r2.rows[0]?.theme?.customCss).toBe(css)
  }, 15_000)

  it('update_theme rejects forbidden customCss with line/column and changes nothing', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })

    const { plaintext } = await mintPat({ userId: user.id, scopes: WRITE_SCOPES })
    const res = await mcp(plaintext).call('update_theme', {
      doc_id: doc.docId,
      customCss: 'p { color: red }\np { background: url(http://evil.test/x.png) }'
    })
    expect(res.isError).toBe(true)
    const text = res.content.find(c => c.type === 'text')?.text ?? ''
    expect(text).toMatch(/line 2, column \d+: url\(\) may only point at an image uploaded to this document/)

    await new Promise(r => setTimeout(r, 1000))
    const r2 = await testDb().query<{ theme: unknown }>(
      `SELECT theme FROM documents WHERE doc_id = $1`, [doc.docId]
    )
    expect(r2.rows[0]?.theme ?? null).toBeNull()
  }, 15_000)
})

describe('MCP write tools: comment lifecycle', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('create_comment then resolve_comment then delete_comment all return non-error', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    await seedYjs(doc.docId, 'line one\nline two\nline three')

    const client = mcp((await mintPat({ userId: user.id, scopes: WRITE_SCOPES })).plaintext)

    const create = await client.call('create_comment', {
      doc_id: doc.docId,
      start_line: 1,
      end_line: 1,
      body: 'first comment'
    })
    expect(create.isError).not.toBe(true)
    const createText = create.content[0]?.type === 'text' ? create.content[0].text : ''
    // Comment id is surfaced in the response so subsequent calls have it.
    const idMatch = createText.match(/[a-zA-Z0-9_-]{8,}/)
    expect(idMatch).not.toBeNull()
    const commentId = idMatch![0]

    const resolve = await client.call('resolve_comment', {
      doc_id: doc.docId,
      comment_id: commentId,
      resolved: true
    })
    expect(resolve.isError).not.toBe(true)

    const del = await client.call('delete_comment', {
      doc_id: doc.docId,
      comment_id: commentId
    })
    expect(del.isError).not.toBe(true)
  }, 30_000)
})

describe('MCP write tools: activity_log attribution', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('an MCP edit produces an activity_log row with actor_principal LIKE mcp:%', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    await seedYjs(doc.docId, 'content to mutate')

    const client = mcp((await mintPat({ userId: user.id, scopes: WRITE_SCOPES })).plaintext)
    await client.call('replace_text', {
      doc_id: doc.docId,
      old_str: 'content',
      new_str: 'CONTENT'
    })

    // Activity rows land via the sync-server's onChange → onStoreDocument
    // → /internal/activity round-trip. Hocuspocus debounces store events
    // 2-10s; we wait conservatively long for the row to land before
    // asserting. Without this the assertion races against the debounce
    // window and fails non-deterministically.
    await new Promise(r => setTimeout(r, 12_000))

    const rows = await activityRowsForDoc(doc.docId)
    expect(rows.length).toBeGreaterThan(0)
    const mcpRow = rows.find(r => r.actor_principal?.startsWith('mcp:'))
    expect(mcpRow, `expected an mcp:% actor_principal row, got: ${JSON.stringify(rows)}`).toBeDefined()
    expect(mcpRow!.action).toBe('edit')
  }, 30_000)
})
