// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { useQueryCache } from '@pinia/colada'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { AiGenerateImageModal } from '#components'
import { aiKeys } from '~/queries/ai'
import type { AiAvailability } from '~~/shared/ai/providers'

// Insert → "Generate image with AI" (staging finding G1): the cost shows
// before generating, the server's image lands at the cursor as its own
// paragraph, and refusals (no provider, budget used up) say what to do.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
const { explainLocked } = vi.hoisted(() => ({ explainLocked: vi.fn() }))
mockNuxtImport('useAiLockedPrompt', () => () => ({ explainLocked }))

const MD = '![A lighthouse at dusk](/api/files/doc12345/abc.jpg)'
const bodies: unknown[] = []
let refusal: { statusCode: number, data: Record<string, unknown> } | null = null
registerEndpoint('/api/docs/doc12345/images/generate', {
  method: 'POST',
  handler: async (event) => {
    const { readBody, createError } = await import('h3')
    bodies.push(await readBody(event))
    if (refusal) throw createError(refusal)
    return { markdown: MD, url: '/api/files/doc12345/abc.jpg' }
  }
})
registerEndpoint('/api/ai/credits', () => ({}))

function availability(image: Partial<AiAvailability['image']>): AiAvailability {
  const none = { available: false, source: 'none' as const, platformBilled: false }
  return {
    chat: { ...none, supportsVision: false },
    image: { ...none, ...image },
    transcription: { ...none, liveDictation: false },
    webTools: { search: false, fetch: false }
  }
}

let view: EditorView
const mounted: Array<{ unmount: () => void }> = []

beforeEach(() => {
  bodies.length = 0
  refusal = null
  explainLocked.mockReset()
  view = new EditorView({ state: EditorState.create({ doc: 'Intro. More.', selection: { anchor: 6 } }) })
})
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  view.destroy()
  useGenerateImageDialog().open.value = false
})

async function openModal(image: Partial<AiAvailability['image']>) {
  useQueryCache().setQueryData(aiKeys.availabilityFor(null), availability(image))
  const wrapper = await mountSuspended(AiGenerateImageModal, { props: { docId: 'doc12345', view, readOnly: false } })
  mounted.push(wrapper)
  useGenerateImageDialog().request()
  await flushPromises()
  return wrapper
}

const $ = (testid: string) => document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)

async function typeAndGenerate(prompt: string) {
  const area = $('generate-image-prompt')?.querySelector('textarea') ?? document.querySelector<HTMLTextAreaElement>('textarea[data-testid="generate-image-prompt"]')
  if (!area) throw new Error('no prompt field')
  area.value = prompt
  area.dispatchEvent(new Event('input'))
  await flushPromises()
  $('generate-image-submit')?.click()
  await flushPromises()
}

describe('Generate image with AI', () => {
  it('shows the price, sends the prompt and size, and puts the image at the cursor', async () => {
    await openModal({ available: true, source: 'instance', platformBilled: true, pricePerImageUsd: 0.009 })
    expect($('generate-image-cost')?.textContent).toContain('Costs about 9 AI Points.')

    await typeAndGenerate('A lighthouse at dusk')
    expect(bodies).toEqual([{ prompt: 'A lighthouse at dusk', size: 'square' }])
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(`Intro.\n\n${MD}\n\n More.`))
    expect(useGenerateImageDialog().open.value).toBe(false)
  })

  it('on the user\'s own key: no AI Points', async () => {
    await openModal({ available: true, source: 'user', platformBilled: false, pricePerImageUsd: null })
    expect($('generate-image-cost')?.textContent).toContain('Runs on your own image provider.')
  })

  it('without an image provider: the way to the settings instead of the form', async () => {
    await openModal({ available: false })
    expect($('generate-image-missing')?.textContent).toContain('No image provider set up')
    expect($('generate-image-prompt')).toBeNull()
  })

  it('a refusal stays in the dialog with its text, nothing is inserted', async () => {
    refusal = { statusCode: 402, data: { code: 'ai/budget-exhausted' } }
    await openModal({ available: true, source: 'instance', platformBilled: true, pricePerImageUsd: 0.009 })
    await typeAndGenerate('A lighthouse')
    await vi.waitFor(() => expect($('generate-image-error')?.textContent).toContain('AI Points for this period are used up'))
    expect(view.state.doc.toString()).toBe('Intro. More.')
    expect(useGenerateImageDialog().open.value).toBe(true)
  })

  it('a plan without image generation explains the lock instead of opening', () => {
    useQueryCache().setQueryData(aiKeys.availabilityFor(null), availability({ available: false, locked: 'plan' }))
    useGenerateImageDialog().request()
    expect(explainLocked).toHaveBeenCalledWith('aiImage')
    expect(useGenerateImageDialog().open.value).toBe(false)
  })
})
