import { describe, it, expect } from 'vitest'
import {
  CONVERSATION_IDLE_GAP_MS,
  CONVERSATION_MAX_ROWS,
  buildConversationContextForPrompt,
  buildConversationHistoryBlock,
  shouldRecordToolInMemory,
  summarizeToolCall
} from '../../../server/utils/agentic/conversationMemory'
import { parseAiMessageEntry, type AiMessageRow } from '../../../server/repos/aiSessionMessages'

// Pure-function unit tests for the AI conversation memory helpers.
// These compose into the agentic loop's `<conversation_history>` block
// and govern the bloat-prevention rules (skip-list, summary, truncation).
// All branches stay testable in-process, no DB, no Nuxt, no awareness.

function row(
  id: number,
  kind: AiMessageRow['kind'],
  body: unknown,
  msAgo = 0
): AiMessageRow {
  return {
    id,
    docId: 'doc-x',
    userId: 1,
    sessionId: 'sess-x',
    ...parseAiMessageEntry(kind, body),
    createdAt: new Date(Date.now() - msAgo)
  }
}

describe('shouldRecordToolInMemory', () => {
  // The skip set covers tools the model re-runs every turn just to
  // read state. Recording them would balloon the prompt block without
  // helping context resolution. Pin every expected entry so adding /
  // removing one is a deliberate change that breaks this test.
  it.each(
    [
      'view_document', 'read_comments',
      'get_theme', 'list_themes',
      'list_workspace_documents', 'list_my_documents', 'list_folders',
      'get_page_count', 'search_activity_log'
    ]
  )('returns false for skip-listed tool %s', (name) => {
    expect(shouldRecordToolInMemory(name)).toBe(false)
  })

  it.each(
    [
      'replace_text', 'insert_text', 'set_title',
      'web_search', 'fetch_url', 'view_image', 'generate_image',
      'view_pages', 'search_knowledge', 'get_knowledge_file',
      'view_other_document', 'update_theme', 'save_theme_as_preset',
      'create_comment', 'reply_to_comment', 'resolve_comment',
      'delete_comment', 'message_to_user',
      'search_documents', 'move_document', 'create_folder'
    ]
  )('returns true for recordable tool %s', (name) => {
    expect(shouldRecordToolInMemory(name)).toBe(true)
  })

  it('returns true for unknown tools (default-to-record)', () => {
    // Forward-compatibility: a future tool we forgot to opt into the
    // skip set should be recorded by default. False positives are
    // recoverable (block grows by one line), false negatives lose
    // context the model needed.
    expect(shouldRecordToolInMemory('hypothetical_new_tool')).toBe(true)
  })
})

describe('summarizeToolCall', () => {
  // Each summary picks the ONE field that conveys what the call did,
  // capped to a small char count so the block stays bounded.
  // Strings are quoted; numbers / booleans / arrays are bare. Length
  // caps are tested implicitly via `.length` assertions where they
  // matter (the model needs short, not omitted).

  it('replace_text returns old= snippet', () => {
    expect(summarizeToolCall('replace_text', { old_str: 'lorem ipsum dolor', new_str: 'sit amet' }))
      .toBe('old≈"lorem ipsum dolor"')
  })

  it('replace_text trims old_str at 60 chars', () => {
    const long = 'x'.repeat(120)
    const out = summarizeToolCall('replace_text', { old_str: long, new_str: 'y' })
    expect(out).toBe(`old≈"${'x'.repeat(60)}"`)
  })

  it('insert_text emits at_line + truncated text', () => {
    expect(summarizeToolCall('insert_text', { insert_line: 12, insert_text: 'A new paragraph here.' }))
      .toBe('at_line=12 text≈"A new paragraph here."')
  })

  it('set_title emits the title verbatim', () => {
    expect(summarizeToolCall('set_title', { title: 'Quarterly Plan' }))
      .toBe('title="Quarterly Plan"')
  })

  it.each([
    ['web_search', { query: 'GPT-5 release date' }, 'query="GPT-5 release date"'],
    ['fetch_url', { url: 'https://example.com/blog' }, 'url="https://example.com/blog"'],
    ['view_image', { src: '/api/files/abc/def.png' }, 'src="/api/files/abc/def.png"'],
    ['generate_image', { prompt: 'A handshake, photorealistic' }, 'prompt="A handshake, photorealistic"'],
    ['search_knowledge', { query: 'vendor onboarding' }, 'query="vendor onboarding"'],
    ['get_knowledge_file', { knowledge_id: 'k_abc123' }, 'knowledge_id=k_abc123'],
    ['view_other_document', { doc_id: 'doc-9' }, 'doc=doc-9'],
    ['search_documents', { query: 'q3 retro' }, 'query="q3 retro"'],
    ['move_document', { doc_id: 'doc-9', folder_id: 'f_1' }, 'doc=doc-9 folder_id=f_1'],
    ['move_document', { doc_id: 'doc-9', folder_id: null }, 'doc=doc-9 folder_id=null'],
    ['create_folder', { name: 'Specs', parent_id: 'f_1' }, 'name="Specs" parent_id=f_1'],
    ['create_folder', { name: 'Specs' }, 'name="Specs"']
  ])('summarises %s tightly', (name, args, expected) => {
    expect(summarizeToolCall(name, args)).toBe(expected)
  })

  it('view_pages serialises the pages array', () => {
    expect(summarizeToolCall('view_pages', { pages: [3, 5] })).toBe('pages=[3,5]')
  })

  it('view_pages caps at 5 page entries', () => {
    expect(summarizeToolCall('view_pages', { pages: [1, 2, 3, 4, 5, 6, 7] })).toBe('pages=[1,2,3,4,5]')
  })

  it('update_theme prefers preset over field list', () => {
    expect(summarizeToolCall('update_theme', { preset: 'arxiv', headings: { weight: '600' } }))
      .toBe('preset=arxiv')
  })

  it('update_theme reports theme_id when present', () => {
    expect(summarizeToolCall('update_theme', { theme_id: 'thm_abc123def' }))
      .toBe('theme_id=thm_abc123def')
  })

  it('update_theme reports from_workspace_default', () => {
    expect(summarizeToolCall('update_theme', { from_workspace_default: true }))
      .toBe('from_workspace_default=true')
  })

  it('update_theme falls back to field-key list when no base source', () => {
    const out = summarizeToolCall('update_theme', {
      page: { margin: 20 },
      body: { font: 'Inter' },
      headings: { weight: '600' }
    })
    expect(out).toBe('fields=page,body,headings')
  })

  it('comment ops include comment_id + body preview', () => {
    expect(summarizeToolCall('create_comment', { start_line: 4, end_line: 7, body: 'Should we cite the source?' }))
      .toBe('lines=4-7 body≈"Should we cite the source?"')
    expect(summarizeToolCall('reply_to_comment', { comment_id: 'c_xyz', body: 'Yes \u2014 added.' }))
      .toBe('comment_id=c_xyz body≈"Yes \u2014 added."')
    expect(summarizeToolCall('resolve_comment', { comment_id: 'c_xyz', resolved: true }))
      .toBe('comment_id=c_xyz resolved=true')
    expect(summarizeToolCall('delete_comment', { comment_id: 'c_xyz', reply_id: 'r_1' }))
      .toBe('comment_id=c_xyz reply_id=r_1')
    expect(summarizeToolCall('delete_comment', { comment_id: 'c_xyz' }))
      .toBe('comment_id=c_xyz')
  })

  it('save_theme_as_preset emits the name', () => {
    expect(summarizeToolCall('save_theme_as_preset', { name: 'Brand red' }))
      .toBe('name="Brand red"')
  })

  it('falls back to args=<keys> for unknown tools', () => {
    expect(summarizeToolCall('hypothetical_new_tool', { foo: 1, bar: 'x', baz: true }))
      .toBe('args=foo,bar,baz')
  })

  it('returns empty string for non-object args', () => {
    expect(summarizeToolCall('replace_text', null)).toBe('')
    expect(summarizeToolCall('replace_text', 'not-an-object')).toBe('')
    expect(summarizeToolCall('replace_text', 42)).toBe('')
  })
})

describe('buildConversationHistoryBlock', () => {
  it('returns empty string when there are no rows', () => {
    expect(buildConversationHistoryBlock([])).toBe('')
  })

  it('wraps the rows in <conversation_history> tags', () => {
    const block = buildConversationHistoryBlock([
      row(1, 'user_prompt', { text: 'Hi markoto' })
    ])
    expect(block).toMatch(/<conversation_history>/)
    expect(block).toMatch(/<\/conversation_history>/)
  })

  it('renders user_prompt rows with the user prefix', () => {
    const block = buildConversationHistoryBlock([
      row(1, 'user_prompt', { text: 'Build a pricing table' })
    ])
    expect(block).toContain('- user: Build a pricing table')
  })

  it('truncates very long user prompts at 800 chars', () => {
    const long = 'x'.repeat(1500)
    const block = buildConversationHistoryBlock([row(1, 'user_prompt', { text: long })])
    // 800 chars + ellipsis
    expect(block).toContain(`- user: ${'x'.repeat(800)}…`)
    expect(block).not.toContain('x'.repeat(801))
  })

  it('renders message_to_user as "AI replied"', () => {
    const block = buildConversationHistoryBlock([
      row(1, 'message_to_user', { message: 'I rewrote the intro.', isQuestion: false })
    ])
    expect(block).toContain('- AI replied: I rewrote the intro.')
  })

  it('renders an isQuestion message_to_user as "AI asked"', () => {
    const block = buildConversationHistoryBlock([
      row(1, 'message_to_user', { message: 'Which language?', isQuestion: true })
    ])
    expect(block).toContain('- AI asked: Which language?')
  })

  it('renders tool_call rows with summary in parens', () => {
    const block = buildConversationHistoryBlock([
      row(1, 'tool_call', { name: 'insert_text', summary: 'at_line=12 text≈"hello"' })
    ])
    expect(block).toContain('- AI used insert_text (at_line=12 text≈"hello")')
  })

  it('renders tool_call rows without parens when summary is empty', () => {
    const block = buildConversationHistoryBlock([
      row(1, 'tool_call', { name: 'view_image', summary: '' })
    ])
    expect(block).toContain('- AI used view_image')
    expect(block).not.toContain('view_image (')
  })

  it('preserves chronological order in the rendered lines', () => {
    const block = buildConversationHistoryBlock([
      row(1, 'user_prompt', { text: 'first' }),
      row(2, 'tool_call', { name: 'insert_text', summary: 'at_line=1 text≈"x"' }),
      row(3, 'message_to_user', { message: 'done', isQuestion: false }),
      row(4, 'user_prompt', { text: 'second' })
    ])
    const firstIdx = block.indexOf('first')
    const insertIdx = block.indexOf('insert_text')
    const repliedIdx = block.indexOf('AI replied')
    const secondIdx = block.indexOf('second')
    expect(firstIdx).toBeGreaterThan(0)
    expect(insertIdx).toBeGreaterThan(firstIdx)
    expect(repliedIdx).toBeGreaterThan(insertIdx)
    expect(secondIdx).toBeGreaterThan(repliedIdx)
  })

  it('emits the truncation sentinel when row count exceeds the cap', () => {
    const rows: AiMessageRow[] = []
    for (let i = 0; i < CONVERSATION_MAX_ROWS + 5; i++) {
      rows.push(row(i + 1, 'user_prompt', { text: `prompt #${i + 1}` }))
    }
    const block = buildConversationHistoryBlock(rows)
    expect(block).toContain('(5 earlier turns omitted')
    // First (oldest) prompt got dropped; last (newest) is kept.
    expect(block).not.toContain('prompt #1\n')
    expect(block).toContain(`prompt #${CONVERSATION_MAX_ROWS + 5}`)
  })

  it('does NOT emit the truncation sentinel at exactly the cap', () => {
    const rows: AiMessageRow[] = []
    for (let i = 0; i < CONVERSATION_MAX_ROWS; i++) {
      rows.push(row(i + 1, 'user_prompt', { text: `p${i + 1}` }))
    }
    const block = buildConversationHistoryBlock(rows)
    expect(block).not.toContain('earlier turns omitted')
  })

  it('singularises the truncation sentinel for one omitted row', () => {
    const rows: AiMessageRow[] = []
    for (let i = 0; i < CONVERSATION_MAX_ROWS + 1; i++) {
      rows.push(row(i + 1, 'user_prompt', { text: `p${i + 1}` }))
    }
    const block = buildConversationHistoryBlock(rows)
    expect(block).toContain('(1 earlier turn omitted')
  })

  it('skips empty / unknown row kinds gracefully', () => {
    // Defence against schema drift, a future kind value would
    // produce no line but shouldn't crash the renderer.
    const rows = [
      row(1, 'user_prompt', { text: 'real' }),
      row(2, 'tool_call' as const, null), // body=null still emits "AI used <unknown>"
      row(3, 'user_prompt', { text: 'another real' })
    ]
    const block = buildConversationHistoryBlock(rows)
    expect(block).toContain('- user: real')
    expect(block).toContain('- AI used <unknown>')
    expect(block).toContain('- user: another real')
  })
})

describe('buildConversationContextForPrompt', () => {
  it('returns empty block + idleReset=true when last activity is past the gap', async () => {
    const lastActivity = new Date(Date.now() - CONVERSATION_IDLE_GAP_MS - 10_000)
    const ctx = await buildConversationContextForPrompt(async () => [], lastActivity)
    expect(ctx.idleReset).toBe(true)
    expect(ctx.block).toBe('')
    expect(ctx.since).toBeNull()
  })

  it('loads + renders rows when last activity is within the gap', async () => {
    const lastActivity = new Date(Date.now() - 30_000)
    const ctx = await buildConversationContextForPrompt(
      async () => [row(1, 'user_prompt', { text: 'hi' })],
      lastActivity
    )
    expect(ctx.idleReset).toBe(false)
    expect(ctx.block).toContain('- user: hi')
    expect(ctx.since).toBeInstanceOf(Date)
  })

  it('treats null lastActivity as "no prior memory", loads anyway', async () => {
    // First-ever prompt for a (doc,user) pair: no rows exist, but we
    // still call the loader (which will return []). Important so that
    // a new doc behaves identically to an idle-reset doc, empty
    // block, no error.
    const ctx = await buildConversationContextForPrompt(async () => [], null)
    expect(ctx.idleReset).toBe(false)
    expect(ctx.block).toBe('')
    expect(ctx.since).toBeInstanceOf(Date)
  })

  it('passes the gap-windowed `since` to the loader', async () => {
    const now = new Date('2026-05-01T12:00:00Z')
    let receivedSince: Date | undefined
    await buildConversationContextForPrompt(
      async (since) => {
        receivedSince = since
        return []
      },
      new Date(now.getTime() - 1000),
      now
    )
    // Window is [now - IDLE_GAP_MS, now]
    expect(receivedSince).toBeInstanceOf(Date)
    expect(receivedSince!.getTime()).toBe(now.getTime() - CONVERSATION_IDLE_GAP_MS)
  })
})
