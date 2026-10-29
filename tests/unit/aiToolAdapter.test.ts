import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { executeFunctionByName } from '../../server/utils/aiToolAdapter'
import type { AiSession } from '../../server/utils/aiClient'

// AI tool handlers — the functions the model uses to mutate user
// docs (view_document, replace_text, insert_text). Wrong semantics
// here = silent data corruption in the user's document, so every
// branch gets pinned: match-count rules, line-to-char mapping,
// transaction origin tags, unicode alignment.

// Minimal AiSession stub. Handlers only touch ydoc, ytext, sessionId,
// and updateStatus — everything else is awareness/provider plumbing the
// handlers never read, so we stub with `null as never`.
interface StubSession {
  session: AiSession
  ytext: Y.Text
  ydoc: Y.Doc
  statusCalls: Array<{ phase: string, message?: string }>
  originsSeen: Set<string>
}

function makeSession(initial = '', sessionId = 'test-session'): StubSession {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  if (initial) ytext.insert(0, initial)

  const statusCalls: Array<{ phase: string, message?: string }> = []
  const originsSeen = new Set<string>()
  // Capture every transaction's origin so tests can assert the tool
  // tagged its edits correctly. Handlers pass `ai:assistant:{sid}` as the
  // second arg to ydoc.transact — yjs surfaces it via transaction.origin.
  ydoc.on('afterTransaction', (tx) => {
    if (tx.origin != null) originsSeen.add(String(tx.origin))
  })

  const session = {
    ydoc,
    ytext,
    ymeta: ydoc.getMap('meta'),
    awareness: null as never,
    provider: null as never,
    sessionId,
    updateStatus: vi.fn((phase: string, message?: string) => {
      statusCalls.push({ phase, message })
    }),
    destroy: async () => {}
  } as unknown as AiSession

  return { session, ytext, ydoc, statusCalls, originsSeen }
}

describe('view_document', () => {
  it('returns full doc with 1-indexed line prefixes', async () => {
    const { session } = makeSession('hello\nworld\n!')
    const res = await executeFunctionByName(session, 'view_document', {})
    expect(res.isError).toBe(false)
    expect(res.content).toBe('1: hello\n2: world\n3: !')
  })

  it('handles empty doc', async () => {
    // An empty Y.Text splits to [""], so the view shows "1: " (one empty
    // line). This matches what the model would see for a brand-new doc.
    const { session } = makeSession('')
    const res = await executeFunctionByName(session, 'view_document', {})
    expect(res.isError).toBe(false)
    expect(res.content).toBe('1: ')
  })

  it('respects view_range [start, end]', async () => {
    const { session } = makeSession('a\nb\nc\nd\ne')
    const res = await executeFunctionByName(session, 'view_document', { view_range: [2, 4] })
    expect(res.content).toBe('2: b\n3: c\n4: d')
  })

  it('interprets end=-1 as "to end of file"', async () => {
    const { session } = makeSession('a\nb\nc')
    const res = await executeFunctionByName(session, 'view_document', { view_range: [2, -1] })
    expect(res.content).toBe('2: b\n3: c')
  })

  it('errors on start < 1', async () => {
    const { session } = makeSession('a\nb')
    const res = await executeFunctionByName(session, 'view_document', { view_range: [0, 2] })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('view_range start must be >= 1')
  })

  it('errors on end < start', async () => {
    const { session } = makeSession('a\nb\nc')
    const res = await executeFunctionByName(session, 'view_document', { view_range: [3, 2] })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('view_range end must be >= start')
  })

  it('range beyond file returns empty slice with start prefix (no error)', async () => {
    // Current behaviour — documented here so a future change to "error on
    // past-end range" is an explicit decision, not an accident. Model
    // should figure it out from the empty result; we don't need to block.
    const { session } = makeSession('a\nb')
    const res = await executeFunctionByName(session, 'view_document', { view_range: [5, 10] })
    expect(res.isError).toBe(false)
    expect(res.content).toBe('5: ')
  })
})

describe('replace_text', () => {
  it('replaces a unique match', async () => {
    const { session, ytext } = makeSession('hello world')
    const res = await executeFunctionByName(session, 'replace_text', {
      old_str: 'world',
      new_str: 'moon'
    })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe('hello moon')
  })

  it('allows empty new_str (delete-only)', async () => {
    const { session, ytext } = makeSession('hello world')
    const res = await executeFunctionByName(session, 'replace_text', {
      old_str: ' world',
      new_str: ''
    })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe('hello')
  })

  it('errors when no matches found', async () => {
    const { session, ytext } = makeSession('hello')
    const res = await executeFunctionByName(session, 'replace_text', {
      old_str: 'nope',
      new_str: 'yep'
    })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('No match found')
    expect(ytext.toString()).toBe('hello')
  })

  it('errors on multiple matches with count in message', async () => {
    // Regression target — if this silently took the first match, an AI
    // replace of a common word would rewrite the wrong sentence.
    const { session, ytext } = makeSession('foo bar foo bar foo')
    const res = await executeFunctionByName(session, 'replace_text', {
      old_str: 'foo',
      new_str: 'BAZ'
    })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('Found 3 matches')
    expect(ytext.toString()).toBe('foo bar foo bar foo')
  })

  it('match at start of doc', async () => {
    const { session, ytext } = makeSession('abc def')
    const res = await executeFunctionByName(session, 'replace_text', {
      old_str: 'abc',
      new_str: 'XYZ'
    })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe('XYZ def')
  })

  it('match at end of doc', async () => {
    const { session, ytext } = makeSession('abc def')
    const res = await executeFunctionByName(session, 'replace_text', {
      old_str: 'def',
      new_str: 'XYZ'
    })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe('abc XYZ')
  })

  it('match spans multiple lines', async () => {
    const { session, ytext } = makeSession('line1\nline2\nline3')
    const res = await executeFunctionByName(session, 'replace_text', {
      old_str: 'line1\nline2',
      new_str: 'merged'
    })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe('merged\nline3')
  })

  it('unicode / emoji match aligns with Y.Text indexing', async () => {
    // Both JS String.prototype.indexOf and Y.Text.insert/delete operate
    // in UTF-16 code units. An emoji like 😀 is 2 code units, and an
    // indexOf match must carry the right code-unit length to the
    // Y.Text.delete call. Regression guard.
    const { session, ytext } = makeSession('hello 😀 world')
    const res = await executeFunctionByName(session, 'replace_text', {
      old_str: '😀',
      new_str: '🎉'
    })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe('hello 🎉 world')
  })

  it('tags transaction with ai:assistant:{sessionId} origin', async () => {
    // The UI filters remote-origin updates to animate AI edits
    // differently — if this tag drifts, the animation breaks silently.
    const { session, originsSeen } = makeSession('hello', 'sess-42')
    await executeFunctionByName(session, 'replace_text', {
      old_str: 'hello',
      new_str: 'goodbye'
    })
    expect(originsSeen.has('ai:assistant:sess-42')).toBe(true)
  })

  it('emits "editing" status before mutating', async () => {
    const { session, statusCalls } = makeSession('hello')
    await executeFunctionByName(session, 'replace_text', {
      old_str: 'hello',
      new_str: 'hi'
    })
    expect(statusCalls[0]?.phase).toBe('editing')
  })

  it('leading/trailing whitespace is NOT stripped — exact match required', async () => {
    // The model is instructed to match exactly including whitespace.
    // If we trimmed, a replace of "  foo" in "  foo  " would succeed
    // with 3 hidden matches (leading, trailing, both).
    const { session, ytext } = makeSession('  hello  ')
    const res = await executeFunctionByName(session, 'replace_text', {
      old_str: 'hello',
      new_str: 'HI'
    })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe('  HI  ')
  })

  it('non-overlapping match counter (matches cannot overlap)', async () => {
    // "aa" in "aaaa" is counted as 2 non-overlapping matches (positions
    // 0, 2) — NOT 3 overlapping. Confirms indexOf advances by
    // needle.length, not by 1. If the counter went to 3+ and then threw
    // on "multiple matches", a legit dedupe would wrongly error.
    const { session } = makeSession('aaaa')
    const res = await executeFunctionByName(session, 'replace_text', {
      old_str: 'aa',
      new_str: 'X'
    })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('Found 2 matches')
  })
})

describe('insert_text', () => {
  it('insert_line=0 prepends at start of file', async () => {
    const { session, ytext } = makeSession('world\n')
    const res = await executeFunctionByName(session, 'insert_text', {
      insert_line: 0,
      insert_text: 'hello\n'
    })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe('hello\nworld\n')
  })

  it('insert_line=N inserts after line N', async () => {
    const { session, ytext } = makeSession('a\nb\nc')
    const res = await executeFunctionByName(session, 'insert_text', {
      insert_line: 1,
      insert_text: 'X'
    })
    expect(res.isError).toBe(false)
    // After line 1 means right before line 2 → "a\nX\nb\nc".
    expect(ytext.toString()).toBe('a\nX\nb\nc')
  })

  it('insert_line === lines.length appends at end (regression for off-by-one)', async () => {
    // Regression target: pre-fix, this overshot by 1 because the loop
    // added "+1 for newline" after the last line even though there's no
    // trailing newline. Result depended on yjs's bounds-handling and
    // silently put content in the wrong place. The `Math.min(idx, full.length)`
    // clamp in handleInsert pins this to the true end.
    const { session, ytext } = makeSession('hello\nworld')
    const res = await executeFunctionByName(session, 'insert_text', {
      insert_line: 2,
      insert_text: '!'
    })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe('hello\nworld!\n')
  })

  it('insert_line === lines.length on doc with trailing newline appends cleanly', async () => {
    const { session, ytext } = makeSession('hello\nworld\n')
    // split on "\n" gives ["hello", "world", ""], so lines.length = 3.
    const res = await executeFunctionByName(session, 'insert_text', {
      insert_line: 3,
      insert_text: '!'
    })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe('hello\nworld\n!\n')
  })

  it('insert_line > lines.length errors', async () => {
    const { session, ytext } = makeSession('hello\nworld')
    const res = await executeFunctionByName(session, 'insert_text', {
      insert_line: 99,
      insert_text: 'X'
    })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('beyond the end')
    expect(ytext.toString()).toBe('hello\nworld')
  })

  it('insert_line=0 on empty doc works', async () => {
    const { session, ytext } = makeSession('')
    const res = await executeFunctionByName(session, 'insert_text', {
      insert_line: 0,
      insert_text: 'first line'
    })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe('first line\n')
  })

  it('appends auto-newline if insert_text does not end with \\n', async () => {
    const { session, ytext } = makeSession('a\n')
    await executeFunctionByName(session, 'insert_text', {
      insert_line: 0,
      insert_text: 'X' // no trailing \n
    })
    expect(ytext.toString()).toBe('X\na\n')
  })

  it('does NOT double-append \\n if insert_text already has one', async () => {
    const { session, ytext } = makeSession('a\n')
    await executeFunctionByName(session, 'insert_text', {
      insert_line: 0,
      insert_text: 'X\n'
    })
    expect(ytext.toString()).toBe('X\na\n')
    // Specifically: no "X\n\n..." sequence.
    expect(ytext.toString()).not.toContain('X\n\n')
  })

  it('tags transaction with ai:assistant:{sessionId} origin', async () => {
    const { session, originsSeen } = makeSession('hello', 'sess-99')
    await executeFunctionByName(session, 'insert_text', {
      insert_line: 0,
      insert_text: 'prefix\n'
    })
    expect(originsSeen.has('ai:assistant:sess-99')).toBe(true)
  })
})

describe('executeFunctionByName — dispatch', () => {
  it('rejects unknown function name', async () => {
    const { session } = makeSession('hello')
    const res = await executeFunctionByName(session, 'not_a_tool', {})
    expect(res.isError).toBe(true)
    expect(res.content).toContain('Unsupported function')
  })

  it('web_search IS routed through the dispatch table (Phase 2: MCP needs it)', async () => {
    // Phase 2 added web_search + fetch_url to TOOL_HANDLERS so MCP
    // wrappers can call them. The in-app runLoop continues to call
    // `webSearch` directly because it has the abort signal + spend
    // context handy. Either path should work — this test pins that
    // the dispatcher knows about web_search now AND that an unknown
    // name still returns the "Unsupported function" sentinel.
    const { session } = makeSession('')

    // Negative oracle: unknown names hit the dispatcher's `default`
    // branch and return a clean error.
    const unknown = await executeFunctionByName(session, 'definitely_not_a_tool', {})
    expect(unknown.isError).toBe(true)
    expect(unknown.content).toContain('Unsupported function')

    // Positive oracle: web_search is routed (i.e. NOT in the
    // "unknown" branch). We don't actually execute it — that would
    // need runtime config + Jina; instead we assert the dispatcher
    // dispatches it. If it returned the "Unsupported function"
    // sentinel, this test would fail.
    let routedToBridge: boolean
    try {
      const r = await executeFunctionByName(session, 'web_search', { query: 'x' })
      // If it returns synchronously without runtime config, that's
      // already proof — make sure it didn't return the unknown
      // sentinel.
      routedToBridge = !r.content.includes('Unsupported function')
    } catch {
      // Expected — without runtime config the bridge throws inside
      // webSearch. THROWING from inside the handler proves we got
      // past the dispatcher's `default` branch (which never throws).
      routedToBridge = true
    }
    expect(routedToBridge).toBe(true)
  })
})

describe('edit results tell the model what happened', () => {
  it('replace_text with old_str === new_str is rejected and leaves the doc untouched', async () => {
    const { session, ytext, statusCalls } = makeSession('Intro.\n\n---\n\nBody')
    const res = await executeFunctionByName(session, 'replace_text', { old_str: '---\n', new_str: '---\n' })
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/^Error: No change/)
    expect(ytext.toString()).toBe('Intro.\n\n---\n\nBody')
    // No "Applying edit…" status for an edit that never happens.
    expect(statusCalls).toEqual([])
  })

  it('replace_text echoes the resulting lines with one line of context', async () => {
    const { session } = makeSession('# Title\nold line\nnext')
    const res = await executeFunctionByName(session, 'replace_text', { old_str: 'old line', new_str: 'new line\n\nsecond' })
    expect(res.isError).toBe(false)
    expect(res.content).toContain('Lines 2-4 now read')
    expect(res.content).toContain('1: # Title\n2: new line\n3: \n4: second\n5: next')
  })

  it('replace_text that deletes text says so', async () => {
    const { session, ytext } = makeSession('a\nremove me\nb')
    const res = await executeFunctionByName(session, 'replace_text', { old_str: 'remove me\n', new_str: '' })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe('a\nb')
    expect(res.content).toContain('removed')
  })

  it('insert_text echoes the inserted lines, making extra blank lines visible', async () => {
    const { session } = makeSession('# Title\n\nBody')
    const res = await executeFunctionByName(session, 'insert_text', { insert_line: 1, insert_text: '\n' })
    expect(res.isError).toBe(false)
    expect(res.content).toContain('Line 2 now reads')
    // The new empty line 2 next to the existing empty line 3.
    expect(res.content).toContain('1: # Title\n2: \n3: ')
  })

  it('very large edits are summarised instead of echoed', async () => {
    const { session } = makeSession('start\n')
    const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const res = await executeFunctionByName(session, 'insert_text', { insert_line: 1, insert_text: big })
    expect(res.isError).toBe(false)
    expect(res.content).toContain('call view_document')
    expect(res.content).not.toContain('line 39')
  })
})
