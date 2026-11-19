// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport, registerEndpoint, mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, ref, nextTick, type Ref } from 'vue'

import { readBody } from 'h3'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { useEditorSuggestions, useAiSuggestSwitch } from '~/composables/editor/useEditorSuggestions'
import { useImportedProperties } from '~/composables/editor/useImportedProperties'
import { useEditorActions } from '~/composables/editor/useEditorActions'
import { useEditorExports } from '~/composables/editor/useEditorExports'
import { useAiSuggestQuery, useSetAiSuggest, aiKeys } from '~/queries/ai'
import { useQueryCache } from '@pinia/colada'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'

// The editor's suggestion-mode glue: Editing / Suggesting choice, who may
// review, card <-> text moves, the AI-suggests switch, plus the editor
// composables that gained code in the same change.

/** Hand a deliberately partial object to a typed parameter. */
const unsafe = (v: unknown): never => v as never

const m = vi.hoisted(() => ({
  toast: vi.fn(),
  download: vi.fn(),
  createDocument: vi.fn(),
  logout: vi.fn(),
  navigate: vi.fn(),
  loggedIn: true
}))

mockNuxtImport('useToast', () => () => ({ add: m.toast }))
mockNuxtImport('downloadMarkdown', () => m.download)
mockNuxtImport('useAnonDocCreate', () => () => ({ createDocument: m.createDocument }))
mockNuxtImport('useLogout', () => () => ({ logout: m.logout }))
mockNuxtImport('navigateTo', () => m.navigate)
mockNuxtImport('useUserSession', () => () => ({ loggedIn: ref(m.loggedIn), user: ref({ id: 1, name: 'Maya' }), session: ref({}), fetch: vi.fn(), clear: vi.fn() }))

let suggestSetting = { suggest: false }
const putBodies: unknown[] = []
registerEndpoint('/api/user/ai-suggest', {
  method: 'GET',
  handler: () => suggestSetting
})
registerEndpoint('/api/user/ai-suggest', {
  method: 'PUT',
  handler: async (event) => {
    const body = await readBody(event)
    putBodies.push(body)
    suggestSetting = { suggest: body.suggest }
    return suggestSetting
  }
})

beforeEach(() => {
  m.toast.mockReset()
  m.download.mockReset()
  m.createDocument.mockReset()
  m.logout.mockReset()
  m.navigate.mockReset()
  suggestSetting = { suggest: false }
  putBodies.length = 0
})

/** Run a composable inside a component so provide / inject / onUnmounted work. */
async function inComponent<T>(setup: () => T, children?: (value: T) => ReturnType<typeof h>[]) {
  let value!: T
  const Child = defineComponent({
    setup() {
      return () => h('div')
    }
  })
  const wrapper = await mountSuspended(defineComponent({
    setup() {
      value = setup()
      return () => h('div', children ? children(value) : [h(Child)])
    }
  }))
  return { value, wrapper }
}

function editorFixture(over: { isReadOnly?: boolean, suggestOnly?: boolean } = {}) {
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, 'The quick brown fox')
  const awareness = new Awareness(ydoc)
  awareness.setLocalStateField('user', { id: 1, name: 'Maya', color: '#112233' })
  const isReadOnly = ref(over.isReadOnly ?? false)
  const suggestOnly = ref(over.suggestOnly ?? false)
  const rightSidebar = ref<string | null>(null) as Ref<never>
  const flashRange = vi.fn()
  return { ydoc, awareness, isReadOnly, suggestOnly, rightSidebar, flashRange }
}

describe('useEditorSuggestions', () => {
  it('suggests only when chosen and writable; review is for direct editors', async () => {
    const f = editorFixture()
    const { value: s } = await inComponent(() => useEditorSuggestions({ ...f, docId: 'd1' }))
    expect(s.suggesting.value).toBe(false)
    expect(s.canReview.value).toBe(true)
    s.suggestingChosen.value = true
    expect(s.suggesting.value).toBe(true)
    f.isReadOnly.value = true
    expect(s.suggesting.value).toBe(false)
    expect(s.canReview.value).toBe(false)
  })

  it('fixes suggest-only tokens on Suggesting and takes review away', async () => {
    const f = editorFixture({ suggestOnly: true })
    const { value: s } = await inComponent(() => useEditorSuggestions({ ...f, docId: 'd1' }))
    expect(s.suggesting.value).toBe(true)
    expect(s.canReview.value).toBe(false)
  })

  it('counts open suggestions from the document', async () => {
    const f = editorFixture()
    const { value: s } = await inComponent(() => useEditorSuggestions({ ...f, docId: 'd1' }))
    expect(s.count.value).toBe(0)
    s.api.applyPlan({ writes: [{ kind: 'create', from: 4, to: 9, text: 'slow' }], cursor: 0 })
    expect(s.count.value).toBe(1)
  })

  it('opens the suggestions tab and focuses the card when a mark is clicked', async () => {
    const f = editorFixture()
    const { value: s } = await inComponent(() => useEditorSuggestions({ ...f, docId: 'd1' }))
    const focusSuggestion = vi.fn()
    s.panelRef.value = { focusSuggestion }
    s.onSuggestionClick('abc')
    expect(f.rightSidebar.value).toBe('suggestions')
    await nextTick()
    expect(focusSuggestion).toHaveBeenCalledWith('abc')
  })

  it('flashes the text range of a focused card and ignores unknown ids', async () => {
    const f = editorFixture()
    const { value: s } = await inComponent(() => useEditorSuggestions({ ...f, docId: 'd1' }))
    s.api.applyPlan({ writes: [{ kind: 'create', from: 4, to: 9, text: 'slow' }], cursor: 0 })
    s.onSuggestionFocus(s.api.suggestions.value[0]!.id)
    expect(f.flashRange).toHaveBeenCalledWith(4, 9)
    f.flashRange.mockClear()
    s.onSuggestionFocus('nope')
    expect(f.flashRange).not.toHaveBeenCalled()
  })

  it('starts the AI switch from the user setting, lets the prompt bar override it, and reports forced', async () => {
    suggestSetting = { suggest: true }
    const f = editorFixture()
    let injected: ReturnType<typeof useAiSuggestSwitch> = null
    const Probe = defineComponent({
      setup() {
        injected = useAiSuggestSwitch()
        return () => h('span')
      }
    })
    const { value: s } = await inComponent(() => useEditorSuggestions({ ...f, docId: 'd1' }), () => [h(Probe)])
    // earlier tests cached the default answer: refetch the new setting
    await useQueryCache().invalidateQueries({ key: aiKeys.suggest() })
    await vi.waitFor(() => expect(s.aiSuggest.value).toBe(true))
    expect(s.aiSuggestRequest()).toBeUndefined()
    s.aiSuggest.value = false
    expect(s.aiSuggest.value).toBe(false)
    expect(s.aiSuggestRequest()).toBe(false)
    expect(injected).not.toBeNull()
    expect(injected!.aiSuggest.value).toBe(false)
    expect(injected!.forced.value).toBe(false)
    f.suggestOnly.value = true
    expect(injected!.forced.value).toBe(true)
  })

  it('has no switch outside the editor', async () => {
    let injected: unknown = 'unset'
    await inComponent(() => {
      injected = useAiSuggestSwitch()
    })
    expect(injected).toBeNull()
  })
})

describe('AI suggest preference queries', () => {
  it('reads the setting and refreshes it after saving', async () => {
    let q!: ReturnType<typeof useAiSuggestQuery>
    let mut!: ReturnType<typeof useSetAiSuggest>
    let cache!: ReturnType<typeof useQueryCache>
    await inComponent(() => {
      q = useAiSuggestQuery()
      mut = useSetAiSuggest()
      cache = useQueryCache()
    })
    await cache.invalidateQueries({ key: aiKeys.suggest() })
    await vi.waitFor(() => expect(q.data.value).toEqual({ suggest: false }))
    await mut.mutateAsync(true)
    expect(putBodies).toEqual([{ suggest: true }])
    await vi.waitFor(() => expect(q.data.value).toEqual({ suggest: true }))
    expect(aiKeys.suggest()).toEqual([...aiKeys.root, 'suggest'])
    expect(cache.getEntries({ key: aiKeys.suggest() }).length).toBeGreaterThan(0)
  })
})

describe('useImportedProperties', () => {
  function target(over: Record<string, unknown> = {}) {
    return {
      isReadOnly: ref(false), title: ref('Old'), description: ref(''), audience: ref(''), language: ref(''),
      setTemplateId: vi.fn(), canEditTheme: ref(true), setTheme: vi.fn(), ...over
    }
  }

  it('applies every property, the theme when allowed, and toasts success', async () => {
    const t = target()
    const { value: apply } = await inComponent(() => useImportedProperties(t as never))
    const theme = structuredClone(defaultTheme)
    apply(unsafe({ title: 'New', description: 'D', audience: 'executive', language: 'de', templateId: 'letter', theme }), { ignored: [], droppedCustomCssRules: 0 })
    expect(t.title.value).toBe('New')
    expect(t.description.value).toBe('D')
    expect(t.audience.value).toBe('executive')
    expect(t.language.value).toBe('de')
    expect(t.setTemplateId).toHaveBeenCalledWith('letter')
    expect(t.setTheme).toHaveBeenCalledWith(theme)
    expect(m.toast).toHaveBeenCalledWith(expect.objectContaining({ color: 'success', description: undefined }))
  })

  it('leaves unset properties alone and skips the theme without theme rights', async () => {
    const t = target({ canEditTheme: ref(false) })
    const { value: apply } = await inComponent(() => useImportedProperties(t as never))
    apply(unsafe({ theme: structuredClone(defaultTheme) }), { ignored: [], droppedCustomCssRules: 0 })
    expect(t.title.value).toBe('Old')
    expect(t.setTemplateId).not.toHaveBeenCalled()
    expect(t.setTheme).not.toHaveBeenCalled()
  })

  it('notes partly applied imports (ignored keys or dropped CSS rules)', async () => {
    const { value: apply } = await inComponent(() => useImportedProperties(target() as never))
    apply({}, { ignored: ['foo'], droppedCustomCssRules: 0 })
    apply({}, { ignored: [], droppedCustomCssRules: 2 })
    expect(m.toast).toHaveBeenCalledTimes(2)
    for (const call of m.toast.mock.calls) expect(call[0]).toMatchObject({ color: 'neutral', description: expect.any(String) })
  })

  it('does nothing in a read-only document', async () => {
    const t = target({ isReadOnly: ref(true) })
    const { value: apply } = await inComponent(() => useImportedProperties(t as never))
    apply({ title: 'New' }, { ignored: [], droppedCustomCssRules: 0 })
    expect(t.title.value).toBe('Old')
    expect(m.toast).not.toHaveBeenCalled()
  })
})

describe('useEditorActions', () => {
  function awarenessStub() {
    return { setLocalStateField: vi.fn() }
  }

  it('creates a document and navigates to it', async () => {
    m.createDocument.mockResolvedValue('new-doc')
    const { value: a } = await inComponent(() => useEditorActions(awarenessStub() as never))
    await a.newDocument()
    expect(m.navigate).toHaveBeenCalledWith('/d/new-doc')
  })

  it('stays quiet when the visitor cancels the terms, and toasts other failures', async () => {
    const { AnonGateCancelled } = await import('~/composables/account/useAnonGate')
    const { value: a } = await inComponent(() => useEditorActions(awarenessStub() as never))
    m.createDocument.mockRejectedValueOnce(new AnonGateCancelled())
    await a.newDocument()
    expect(m.toast).not.toHaveBeenCalled()
    m.createDocument.mockRejectedValueOnce(new Error('x'))
    await a.newDocument()
    expect(m.toast).toHaveBeenCalledWith(expect.objectContaining({ color: 'error' }))
    expect(m.navigate).not.toHaveBeenCalled()
  })

  it('clears the awareness user before the session goes, even if awareness is gone', async () => {
    const aw = awarenessStub()
    const { value: a } = await inComponent(() => useEditorActions(aw as never))
    m.logout.mockResolvedValue('done')
    await a.handleLogout()
    const { beforeClear } = m.logout.mock.calls[0]![0]
    beforeClear()
    expect(aw.setLocalStateField).toHaveBeenCalledWith('user', null)
    aw.setLocalStateField.mockImplementation(() => {
      throw new Error('torn down')
    })
    expect(() => beforeClear()).not.toThrow()
  })

  it('opens the docs in a new tab without an opener', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { value: a } = await inComponent(() => useEditorActions(awarenessStub() as never))
    a.openDocs()
    expect(open).toHaveBeenCalledWith('/docs', '_blank', 'noopener')
    open.mockRestore()
  })
})

describe('useEditorExports: Markdown with suggestions', () => {
  function exportsFixture(noDownload = false) {
    return {
      docId: 'd1', ytext: new Y.Doc().getText('content'), renderTheme: ref(structuredClone(defaultTheme)),
      theme: ref(structuredClone(defaultTheme)), textContent: ref('The quick brown fox'), title: ref('Report'),
      description: ref(''), audience: ref(''), language: ref('en'), templateId: ref('blank'), noDownload: ref(noDownload),
      brandFonts: ref([]), getDocJwt: async () => null
    }
  }

  it('downloads CriticMarkup for the open suggestions under a "(suggestions)" name', async () => {
    const { value: ex } = await inComponent(() => useEditorExports(exportsFixture() as never))
    await ex.exportMarkdownWithSuggestions([{ from: 4, to: 9, text: 'slow' }])
    expect(m.download).toHaveBeenCalledTimes(1)
    const [content, name] = m.download.mock.calls[0]!
    expect(name).toBe('Report (suggestions)')
    expect(content).toContain('{~~quick~>slow~~}')
  })

  it('exports the plain text without CriticMarkup', async () => {
    const { value: ex } = await inComponent(() => useEditorExports(exportsFixture() as never))
    await ex.exportMarkdown()
    const [content, name] = m.download.mock.calls[0]!
    expect(name).toBe('Report')
    expect(content).toContain('The quick brown fox')
    expect(content).not.toContain('{~~')
  })

  it('refuses both exports on a no-download share', async () => {
    const { value: ex } = await inComponent(() => useEditorExports(exportsFixture(true) as never))
    await ex.exportMarkdownWithSuggestions([{ from: 0, to: 3, text: 'A' }])
    await ex.exportMarkdown()
    expect(m.download).not.toHaveBeenCalled()
    expect(m.toast).toHaveBeenCalledTimes(2)
  })
})
