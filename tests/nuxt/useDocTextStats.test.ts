// @vitest-environment nuxt
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import * as Y from 'yjs'
import type { H3Event } from 'h3'
import { useDocTextStats } from '~/composables/editor/useDocTextStats'

// The owner's tab stores the word count and size 10 s after typing stops
// (PUT /api/docs/:id/meta). A pause after edits that change neither count
// sends nothing: under load every such PUT is a database write.

const bodies: unknown[] = []
registerEndpoint('/api/docs/stats-doc/meta', {
  method: 'PUT',
  handler: async (event: H3Event) => {
    const { readBody } = await import('h3')
    bodies.push(await readBody(event))
    return { success: true }
  }
})

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  bodies.length = 0
  vi.useRealTimers()
})

async function mountStats(ydoc: Y.Doc) {
  const ytext = ydoc.getText('codemirror')
  const Harness = defineComponent({
    setup() {
      useDocTextStats({ docId: 'stats-doc', ydoc, ytext, synced: ref(false), isOwner: ref(true), requiresPassword: ref(false) })
      return () => h('div')
    }
  })
  mounted.push(await mountSuspended(Harness))
  return ytext
}

async function pause(): Promise<void> {
  await vi.advanceTimersByTimeAsync(10_000)
  await flushPromises()
}

describe('useDocTextStats: persisted word count', () => {
  it('stores after a pause, and skips the next pause when both counts are unchanged', async () => {
    vi.useFakeTimers()
    const ydoc = new Y.Doc()
    const ytext = await mountStats(ydoc)

    ytext.insert(0, 'hello world')
    await pause()
    expect(bodies).toEqual([{ wordCount: 2, sizeBytes: 11 }])

    // Same words and bytes after the edit (a letter swapped): nothing sent.
    ytext.delete(0, 1)
    ytext.insert(0, 'j')
    await pause()
    expect(bodies).toHaveLength(1)

    // A real change is stored.
    ytext.insert(ytext.length, ' again')
    await pause()
    expect(bodies).toEqual([{ wordCount: 2, sizeBytes: 11 }, { wordCount: 3, sizeBytes: 17 }])
  })
})
