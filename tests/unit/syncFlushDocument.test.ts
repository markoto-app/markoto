import { describe, expect, it } from 'vitest'
import { flushPendingStore, storeDebounceId, type StoreDebouncer } from '../../sync-server/src/flushDocument'

// `/internal/flush-document` — the app calls it before cloning a live
// document's persisted Y.js rows (duplicate). Driven here against a fake
// of Hocuspocus' store debouncer.

function fakeDebouncer(state: { pending?: boolean, runningPolls?: number }) {
  const calls: string[] = []
  let running = state.runningPolls ?? 0
  const debouncer: StoreDebouncer = {
    isDebounced: (id) => {
      calls.push(`isDebounced:${id}`)
      return state.pending === true
    },
    isCurrentlyExecuting: () => {
      if (running > 0) {
        running--
        return true
      }
      return false
    },
    executeNow: (id) => {
      calls.push(`executeNow:${id}`)
      state.pending = false
      return Promise.resolve()
    }
  }
  return { debouncer, calls }
}

describe('flushPendingStore', () => {
  it('runs a pending debounced store immediately', async () => {
    const { debouncer, calls } = fakeDebouncer({ pending: true })
    const outcome = await flushPendingStore({ documents: new Map([['doc-1', {}]]), debouncer }, 'doc-1')
    expect(outcome).toBe('flushed')
    expect(calls).toContain(`executeNow:${storeDebounceId('doc-1')}`)
  })

  it('waits for a store that is already running', async () => {
    const { debouncer, calls } = fakeDebouncer({ pending: false, runningPolls: 3 })
    const outcome = await flushPendingStore({ documents: new Map([['doc-1', {}]]), debouncer }, 'doc-1', { pollMs: 1 })
    expect(outcome).toBe('flushed')
    expect(calls.some(c => c.startsWith('executeNow'))).toBe(false)
  })

  it('is idle when nothing is pending', async () => {
    const { debouncer } = fakeDebouncer({ pending: false })
    expect(await flushPendingStore({ documents: new Map([['doc-1', {}]]), debouncer }, 'doc-1')).toBe('idle')
  })

  it('reports not-loaded for a document no client has open', async () => {
    const { debouncer, calls } = fakeDebouncer({ pending: true })
    expect(await flushPendingStore({ documents: new Map(), debouncer }, 'doc-1')).toBe('not-loaded')
    expect(calls).toHaveLength(0)
  })

  it('gives up on a store that never finishes', async () => {
    const { debouncer } = fakeDebouncer({ pending: false, runningPolls: Number.POSITIVE_INFINITY })
    await expect(flushPendingStore({ documents: new Map([['doc-1', {}]]), debouncer }, 'doc-1', { timeoutMs: 20, pollMs: 5 }))
      .rejects.toThrow(/still running/)
  })
})
