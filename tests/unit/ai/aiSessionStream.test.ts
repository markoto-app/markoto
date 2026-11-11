import { describe, it, expect, vi } from 'vitest'

// SSE stream of the initiator-only session channel (F-7c), driven by the
// in-memory channel store. Stub Valkey so importing never connects.
vi.mock('../../../server/utils/platform/valkey', () => ({
  useValkey: () => {
    throw new Error('valkey not available in unit tests')
  },
  useValkeySubscriber: () => {
    throw new Error('valkey not available in unit tests')
  }
}))

const { AiSessionChannel, answerSessionConfirmation, createMemoryChannelStore, readSessionChannel } = await import('../../../server/utils/agentic/sessionChannel')
const { createSessionEventStream } = await import('../../../server/utils/agentic/sessionStream')

type Store = ReturnType<typeof createMemoryChannelStore>

const meta = { initiatorUserId: 7, docId: 'doc1', prompt: 'Summarise the Q3 plan', commentThreadId: null }

interface SseEvent { event: string, data: string }

/** Reads SSE frames off the stream; `next()` resolves with the next non-comment event. */
function sseReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  const comments: string[] = []
  async function next(timeoutMs = 2_000): Promise<SseEvent | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const sep = buffer.indexOf('\n\n')
      if (sep >= 0) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const lines = frame.split('\n')
        if (lines.every(l => l.startsWith(':') || l.startsWith('retry:'))) {
          comments.push(frame)
          continue
        }
        const event = lines.find(l => l.startsWith('event: '))?.slice(7) ?? 'message'
        const data = lines.filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n')
        return { event, data }
      }
      if (done) return null
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('timed out waiting for an SSE event')
      const chunk = await Promise.race([
        reader.read(),
        new Promise<'timeout'>(r => setTimeout(() => r('timeout'), remaining))
      ])
      if (chunk === 'timeout') throw new Error('timed out waiting for an SSE event')
      if (chunk.done) done = true
      else buffer += decoder.decode(chunk.value, { stream: true })
    }
  }
  return { next, comments, cancel: () => reader.cancel() }
}

/** Memory store that counts live subscriptions. */
function countingStore(): Store & { live(): number } {
  const base = createMemoryChannelStore()
  let live = 0
  return {
    ...base,
    async subscribe(sid, listener) {
      const unsub = await base.subscribe(sid, listener)
      live++
      let released = false
      return () => {
        if (released) return
        released = true
        live--
        unsub()
      }
    },
    live: () => live
  }
}

const SLOW = { refreshMs: 60_000, terminalGraceMs: 300 }

describe('createSessionEventStream', () => {
  it('sends the current view first, then every change as it is written (no polling interval involved)', async () => {
    const store = countingStore()
    const ch = new AiSessionChannel('s1', store)
    await ch.open(meta)
    await ch.setStatus({ phase: 'thinking', message: null })
    const sse = sseReader(createSessionEventStream({ sessionId: 's1', userId: 7, store, ...SLOW }))

    const first = await sse.next()
    expect(first?.event).toBe('status')
    expect(JSON.parse(first?.data ?? '{}')).toEqual({
      sessionId: 's1', docId: 'doc1', prompt: 'Summarise the Q3 plan', commentThreadId: null,
      phase: 'thinking', message: null, response: null, confirmation: null
    })
    expect(sse.comments.some(c => c.startsWith('retry: '))).toBe(true)

    await ch.setStatus({ phase: 'tool', message: 'Reading "Q3 plan"…' })
    const second = await sse.next(500)
    expect(JSON.parse(second?.data ?? '{}')).toMatchObject({ phase: 'tool', message: 'Reading "Q3 plan"…' })

    // Confirmation request and its clearing both arrive.
    const ac = new AbortController()
    const pending = ch.requestConfirmation({ tool: 'web_search', target: 'q' }, ac.signal, 5_000)
    const asked = JSON.parse((await sse.next(500))?.data ?? '{}')
    expect(asked.confirmation).toMatchObject({ tool: 'web_search', target: 'q' })
    expect(await answerSessionConfirmation('s1', asked.confirmation.id, false, store)).toBe(true)
    expect(await pending).toBe(false)
    expect(JSON.parse((await sse.next(1_000))?.data ?? '{}').confirmation).toBe(null)
    await sse.cancel()
  })

  it('does not resend an unchanged view', async () => {
    const store = countingStore()
    const ch = new AiSessionChannel('s1', store)
    await ch.open(meta)
    await ch.setStatus({ phase: 'tool', message: 'same' })
    const sse = sseReader(createSessionEventStream({ sessionId: 's1', userId: 7, store, ...SLOW }))
    await sse.next()
    await ch.setStatus({ phase: 'tool', message: 'same' })
    await ch.setStatus({ phase: 'tool', message: 'changed' })
    expect(JSON.parse((await sse.next(500))?.data ?? '{}').message).toBe('changed')
    await sse.cancel()
  })

  it('ends with `end` after a terminal phase and the grace period, and releases the subscription', async () => {
    const store = countingStore()
    const ch = new AiSessionChannel('s1', store)
    await ch.open(meta)
    const sse = sseReader(createSessionEventStream({ sessionId: 's1', userId: 7, store, ...SLOW }))
    await sse.next()
    expect(store.live()).toBe(1)
    await ch.setStatus({ phase: 'done', message: 'Done' })
    expect(JSON.parse((await sse.next(500))?.data ?? '{}').phase).toBe('done')
    // A late answer inside the grace period still arrives.
    await ch.setResponse({ message: 'All set.', isQuestion: false, ts: 3 })
    expect(JSON.parse((await sse.next(500))?.data ?? '{}').response).toMatchObject({ message: 'All set.' })
    expect((await sse.next(1_000))?.event).toBe('end')
    expect(await sse.next(500)).toBe(null)
    expect(store.live()).toBe(0)
  })

  it('ends when the channel expires or names another initiator', async () => {
    const store = countingStore()
    const sse = sseReader(createSessionEventStream({ sessionId: 'gone', userId: 7, store, ...SLOW }))
    expect((await sse.next())?.event).toBe('end')
    expect(await sse.next(500)).toBe(null)

    const ch = new AiSessionChannel('s2', store)
    await ch.open({ ...meta, initiatorUserId: 8 })
    const other = sseReader(createSessionEventStream({ sessionId: 's2', userId: 7, store, ...SLOW }))
    expect((await other.next())?.event).toBe('end')
    expect(store.live()).toBe(0)
  })

  it('client disconnect (cancel) releases the subscription and timers', async () => {
    const store = countingStore()
    const ch = new AiSessionChannel('s1', store)
    await ch.open(meta)
    const sse = sseReader(createSessionEventStream({ sessionId: 's1', userId: 7, store, ...SLOW }))
    await sse.next()
    expect(store.live()).toBe(1)
    await sse.cancel()
    expect(store.live()).toBe(0)
    // Writes after the disconnect are harmless.
    await ch.setStatus({ phase: 'tool', message: 'after' })
  })

  it('keeps working without pub/sub: re-reads on the fallback interval', async () => {
    const base = createMemoryChannelStore()
    const store: Store = {
      ...base,
      async subscribe() {
        throw new Error('subscriber down')
      }
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ch = new AiSessionChannel('s1', store)
    await ch.open(meta)
    const sse = sseReader(createSessionEventStream({ sessionId: 's1', userId: 7, store, refreshMs: 60_000, fallbackRefreshMs: 30 }))
    await sse.next()
    await ch.setStatus({ phase: 'tool', message: 'picked up by the re-read' })
    expect(JSON.parse((await sse.next(1_000))?.data ?? '{}').message).toBe('picked up by the re-read')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    await sse.cancel()
  })

  it('sends keep-alive comments on the refresh interval', async () => {
    const store = countingStore()
    const ch = new AiSessionChannel('s1', store)
    await ch.open(meta)
    const sse = sseReader(createSessionEventStream({ sessionId: 's1', userId: 7, store, refreshMs: 20 }))
    await sse.next()
    await new Promise(r => setTimeout(r, 120))
    await ch.setStatus({ phase: 'tool', message: 'x' })
    await sse.next(500)
    expect(sse.comments.filter(c => c === ': ping').length).toBeGreaterThan(0)
    await sse.cancel()
    expect(await readSessionChannel('s1', store)).not.toBe(null)
  })
})
