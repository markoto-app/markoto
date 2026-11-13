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
    await ch.setStatus({ phase: 'tool', message: 'Reading "Q3 plan"…' })
    await ch.setResponse({ message: 'Done', isQuestion: false, ts: 5 })
    expect(await readSessionChannel('s1', store)).toEqual({
      sessionId: 's1',
      ...meta,
      status: { phase: 'tool', message: 'Reading "Q3 plan"…' },
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
    expect(await answerSessionConfirmation('s1', snap.confirmation?.id ?? '', true, store)).toBe(true)
    expect(await pending).toBe(true)
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
    expect(await answerSessionConfirmation('s1', 'stale-id', true, store)).toBe(false)
    expect(await answerSessionConfirmation('s1', id, false, store)).toBe(true)
    expect(await answerSessionConfirmation('s1', id, true, store)).toBe(false)
    expect(await pending).toBe(false)

    const timedOut = await ch.requestConfirmation({ tool: 'web_search', target: 'y' }, new AbortController().signal, 50)
    expect(timedOut).toBe(false)
  })

  it('confirmation: abort ends the wait with false', async () => {
    const store = createMemoryChannelStore()
    const ch = new AiSessionChannel('s1', store)
    const ac = new AbortController()
    const pending = ch.requestConfirmation({ tool: 'web_search', target: 'z' }, ac.signal, 60_000)
    setTimeout(() => ac.abort(), 20)
    expect(await pending).toBe(false)
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
    expect(await ch.requestConfirmation({ tool: 'web_search', target: 'q' }, new AbortController().signal, 1_000)).toBe(false)
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
    expect(await answerSessionConfirmation('s1', snap.confirmation?.id ?? '', true, store, clock)).toBe(false)
    expect(await pending).toBe(false)
  })
})
