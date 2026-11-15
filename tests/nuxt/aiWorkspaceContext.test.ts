// @vitest-environment nuxt
import { describe, it, expect, beforeEach } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { useAiWorkspaceContext, useClaimAiWorkspaceContext } from '~/composables/ai/useAiAvailability'

// The AI workspace context decides whose AI Points the header meter shows:
// a Team / Business workspace's pool on its page and in its documents, the
// user's own budget elsewhere. Navigating mounts the next page before the
// previous one unmounts, so the page that unmounts last must not wipe the
// context the new page set.

function claimer(source: () => string | null) {
  return defineComponent({
    setup() {
      useClaimAiWorkspaceContext(source)
      return () => h('div')
    }
  })
}

beforeEach(() => {
  useAiWorkspaceContext().value = null
})

describe('useClaimAiWorkspaceContext', () => {
  it('follows its source while mounted and clears on unmount', async () => {
    const ws = ref<string | null>(null)
    const page = await mountSuspended(claimer(() => ws.value))
    const context = useAiWorkspaceContext()
    expect(context.value).toBeNull()
    // The workspace loads and turns out to be pooled.
    ws.value = 'ws-pool'
    await nextTick()
    expect(context.value).toBe('ws-pool')
    page.unmount()
    expect(context.value).toBeNull()
  })

  it('workspace page to a document of the same workspace: the document keeps the context', async () => {
    const context = useAiWorkspaceContext()
    const workspacePage = await mountSuspended(claimer(() => 'ws-pool'))
    const documentPage = await mountSuspended(claimer(() => 'ws-pool'))
    workspacePage.unmount()
    expect(context.value).toBe('ws-pool')
    documentPage.unmount()
    expect(context.value).toBeNull()
  })

  it('a document of another workspace keeps its own context when the old page unmounts', async () => {
    const context = useAiWorkspaceContext()
    const first = await mountSuspended(claimer(() => 'ws-a'))
    const second = await mountSuspended(claimer(() => 'ws-b'))
    first.unmount()
    expect(context.value).toBe('ws-b')
    second.unmount()
  })
})
