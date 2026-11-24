// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import type { BillingMode } from '~~/shared/config/billingMode'
import { useEditorInserts } from '~/composables/editor/useEditorInserts'
import { useEditorDictation } from '~/composables/editor/useEditorDictation'

// Limits reached from the editor show their way forward: an image upload
// refused by the storage quota carries the server's "Upgrade" link, and
// live dictation out of AI Points offers the purchase and the own key.

const toastAdd = vi.fn()
mockNuxtImport('useToast', () => () => ({ add: toastAdd }))
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)

const upload = vi.hoisted(() => ({ error: null as null | { value: string | null }, failure: null as null | { value: unknown } }))
mockNuxtImport('useImageUpload', () => () => {
  const error = ref<string | null>(null)
  const failure = ref<unknown>(null)
  upload.error = error
  upload.failure = failure
  return { error, failure, uploading: ref(false), upload: vi.fn(), uploadAndInsert: vi.fn() }
})

const dictation = vi.hoisted(() => ({ options: null as null | { onBudgetExhausted?: (remaining: number) => void } }))
mockNuxtImport('useVoiceDictation', () => (options: { onBudgetExhausted?: (remaining: number) => void }) => {
  dictation.options = options
  return { state: ref('idle'), start: vi.fn(), stop: vi.fn(), toggle: vi.fn() }
})

async function inSetup(fn: () => void) {
  await mountSuspended(defineComponent({
    setup() {
      fn()
      return () => h('div')
    }
  }))
}

beforeEach(() => {
  toastAdd.mockReset()
  navigate.mockReset()
  useState<BillingMode>('billing-mode').value = { billingEnabled: true, plansComingSoon: false, topupsEnabled: true }
})

describe('image upload refused at the storage quota', () => {
  it('the toast carries the server\'s Upgrade link', async () => {
    await inSetup(() => useEditorInserts('doc-1', () => null, ref(false)))
    upload.failure!.value = { statusCode: 409, data: { code: 'upload/storage-quota', recovery: { kind: 'link', href: '/pricing', labelKey: 'ai.upgradeCta' } } }
    upload.error!.value = 'Your image storage is full.'
    await nextTick()
    const toast = toastAdd.mock.calls[0]?.[0]
    expect(toast.title).toBe('Image upload failed')
    expect(toast.actions.map((a: { label: string }) => a.label)).toEqual(['Upgrade'])
    toast.actions[0].onClick()
    expect(navigate).toHaveBeenCalledWith('/pricing')
  })

  it('signed out: the sign-in hint, no action', async () => {
    await inSetup(() => useEditorInserts('doc-1', () => null, ref(false)))
    upload.error!.value = 'login_required'
    await nextTick()
    expect(toastAdd.mock.calls[0]?.[0].actions).toBeUndefined()
  })
})

describe('live dictation out of AI Points', () => {
  it('Free with billing on: Upgrade and the own key', async () => {
    const ydoc = new Y.Doc()
    await inSetup(() => {
      useEditorDictation({ docId: () => 'doc-1', view: () => null, ydoc, ytext: ydoc.getText('t'), awareness: new Awareness(ydoc), userId: () => 1 })
    })
    dictation.options!.onBudgetExhausted!(0)
    const toast = toastAdd.mock.calls[0]?.[0]
    expect(toast.title).toBe('Out of AI Points')
    expect(toast.actions.map((a: { label: string }) => a.label)).toEqual(['Upgrade', 'Add your own key'])
  })
})
