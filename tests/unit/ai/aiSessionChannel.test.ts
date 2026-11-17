import { describe, it, expect, vi } from 'vitest'

// The channel's production store is Valkey; these tests use the
// in-memory store. Stub the Valkey module so importing it never opens a
// connection.
vi.mock('../../../server/utils/platform/valkey', () => ({
  useValkey: () => {
    throw new Error('valkey not available in unit tests')
  }
}))

const {
  AiSessionChannel,
  answerSessionConfirmation,
  createMemoryChannelStore,
  readSessionChannel
} = await import('../../../server/utils/agentic/sessionChannel')

// Initiator-only channel (A2): prompt, status text, answers and
// confirmation round trips live here instead of in Y.js awareness.

const meta = { initiatorUserId: 7, docId: 'doc1', prompt: 'Summarise the Q3 plan', commentThreadId: null }

describe('AiSessionChannel', () => {
  it('stores meta, status and response for the snapshot', async () => {
    const store = createMemoryChannelStore()
    const ch = new AiSessionChannel('s1', store)
    await ch.open(meta)
    await ch.setStatus({ phase: 'tool', message: 'Reading Q3 plan…', step: { key: 'readNamedDocument', params: { title: 'Q3 plan' } } })
    await ch.setResponse({ message: 'Done', isQuestion: false, ts: 5 })
    expect(await readSessionChannel('s1', store)).toEqual({
      sessionId: 's1',
      ...meta,
      status: { phase: 'tool', message: 'Reading Q3 plan…', step: { key: 'readNamedDocument', params: { title: 'Q3 plan' } } },
      response: { message: 'Done', isQuestion: false, ts: 5 },
      confirmation: null
    })
  })

  it('unknown session → null', async () => {
    expect(await readSessionChannel('nope', createMemoryChannelStore())).toBe(null)
  })

  it('confirmation: allow resolves true and the request is cleared', async () => {
    const store = createMemoryChannelStore()
    const ch = new AiSessionChannel('s1', store)
    await ch.open(meta)
    const pending = ch.requestConfirmation({ tool: 'view_other_document', target: 'Q3 plan' }, new AbortController().signal, 5_000)
    const snap = await vi.waitFor(async () => {
      const s = await readSessionChannel('s1', store)
      if (!s?.confirmation) throw new Error('not yet')
      return s
    })
    expect(snap.confirmation).toMatchObject({ tool: 'view_other_document', target: 'Q3 plan' })
    expect(await answerSessionConfirmation('s1', snap.confirmation?.id ?? '', { allow: true }, store)).toBe(true)
    expect(await pending).toEqual({ allowed: true, note: null })
    expect((await readSessionChannel('s1', store))?.confirmation).toBe(null)
  })

  it('confirmation: deny, a stale id, a second answer and a timeout all end in false', async () => {
    const store = createMemoryChannelStore()
    const ch = new AiSessionChannel('s1', store)
    await ch.open(meta)
    const pending = ch.requestConfirmation({ tool: 'web_search', target: 'x' }, new AbortController().signal, 5_000)
    const snap = await vi.waitFor(async () => {
      const s = await readSessionChannel('s1', store)
      if (!s?.confirmation) throw new Error('not yet')
      return s
    })
    const id = snap.confirmation?.id ?? ''
    expect(await answerSessionConfirmation('s1', 'stale-id', { allow: true }, store)).toBe(false)
    expect(await answerSessionConfirmation('s1', id, { allow: false }, store)).toBe(true)
    expect(await answerSessionConfirmation('s1', id, { allow: true }, store)).toBe(false)
    expect(await pending).toEqual({ allowed: false, note: null })

    const timedOut = await ch.requestConfirmation({ tool: 'web_search', target: 'y' }, new AbortController().signal, 50)
    expect(timedOut).toEqual({ allowed: false, note: null })
  })

  it('confirmation: a deny carries the initiator\'s note, trimmed and bounded; an allow drops it', async () => {
    const store = createMemoryChannelStore()
    const ch = new AiSessionChannel('s1', store)
    await ch.open(meta)
    const ask = async () => {
      const pending = ch.requestConfirmation({ tool: 'web_search', target: 'q' }, new AbortController().signal, 5_000)
      const snap = await vi.waitFor(async () => {
        const s = await readSessionChannel('s1', store)
        if (!s?.confirmation) throw new Error('not yet')
        return s
      })
      return { pending, id: snap.confirmation?.id ?? '' }
    }
    const first = await ask()
    expect(await answerSessionConfirmation('s1', first.id, { allow: false, note: '  No, search for pricing instead  ' }, store)).toBe(true)
    expect(await first.pending).toEqual({ allowed: false, note: 'No, search for pricing instead' })

    const second = await ask()
    expect(await answerSessionConfirmation('s1', second.id, { allow: false, note: 'x'.repeat(500) }, store)).toBe(true)
    expect((await second.pending).note).toHaveLength(300)

    const third = await ask()
    expect(await answerSessionConfirmation('s1', third.id, { allow: true, note: 'ignored' }, store)).toBe(true)
    expect(await third.pending).toEqual({ allowed: true, note: null })

    const fourth = await ask()
    expect(await answerSessionConfirmation('s1', fourth.id, { allow: false, note: '   ' }, store)).toBe(true)
    expect(await fourth.pending).toEqual({ allowed: false, note: null })
  })

  it('confirmation: abort ends the wait with false', async () => {
    const store = createMemoryChannelStore()
    const ch = new AiSessionChannel('s1', store)
    const ac = new AbortController()
    const pending = ch.requestConfirmation({ tool: 'web_search', target: 'z' }, ac.signal, 60_000)
    setTimeout(() => ac.abort(), 20)
    expect(await pending).toEqual({ allowed: false, note: null })
  })

  it('fails closed when the store cannot hold the request', async () => {
    const store = createMemoryChannelStore()
    const broken = {
      ...store,
      set: async () => {
        throw new Error('down')
      }
    }
    const ch = new AiSessionChannel('s1', broken)
    expect(await ch.requestConfirmation({ tool: 'web_search', target: 'q' }, new AbortController().signal, 1_000)).toEqual({ allowed: false, note: null })
  })

  it('an expired request cannot be answered', async () => {
    const store = createMemoryChannelStore()
    let now = 1_000
    const clock = () => now
    const ch = new AiSessionChannel('s1', store, clock)
    await ch.open(meta)
    const pending = ch.requestConfirmation({ tool: 'web_search', target: 'q' }, new AbortController().signal, 100)
    const snap = await vi.waitFor(async () => {
      const s = await readSessionChannel('s1', store)
      if (!s?.confirmation) throw new Error('not yet')
      return s
    })
    now = 2_000
    expect(await answerSessionConfirmation('s1', snap.confirmation?.id ?? '', { allow: true }, store, clock)).toBe(false)
    expect(await pending).toEqual({ allowed: false, note: null })
  })
})
