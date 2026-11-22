// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref, shallowRef, type Ref } from 'vue'
import { mountSuspended, mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { EditorLayoutLeftPanel, EditorLayoutLeftPanelHost } from '#components'
import { LEFT_PANEL_STORAGE_KEY } from '~/utils/editor/leftPanel'
import type { OutlineHeading } from '~/utils/editor/documentOutline'
import type { TabName } from '~/components/editor/tabBarTypes'

// The editor's left panel: the tabs (ARIA tablist, arrow keys), the
// outline built from the text (click → the heading), the Workspace tab for
// a member, a guest and a signed-out visitor, and the panel state the
// browser remembers (open, tab, the Ctrl+Shift+E toggle, the jump to a
// heading in editor and preview).

const m = vi.hoisted(() => ({
  navigateTo: vi.fn(),
  loggedIn: null as unknown as Ref<boolean>
}))

mockNuxtImport('navigateTo', () => m.navigateTo)
mockNuxtImport('useUserSession', () => () => ({
  loggedIn: m.loggedIn,
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))

// eslint-disable-next-line import/first -- mockNuxtImport must be hoisted above the import it mocks
import { useEditorLeftPanel } from '~/composables/editor/useEditorLeftPanel'

const now = '2026-11-01T00:00:00Z'
function docRow(docId: string, title: string, folderId: string | null) {
  return {
    docId, title, folderId, description: '', language: 'en', accessMode: 'private', wordCount: 1,
    ownerId: 1, ownerName: 'Maya', isOwner: true, createdAt: now, updatedAt: now, lastActive: now
  }
}

registerEndpoint('/api/workspaces/ws1/folders', () => ({
  folders: [{ folderId: 'f1', parentId: null, name: 'Research', docCount: 1, updatedAt: now }]
}))
registerEndpoint('/api/workspaces/ws1/documents', () => ({
  items: [docRow('cur', 'Interview notes', 'f1'), docRow('other', 'Roadmap', null)],
  total: 2,
  nextCursor: null
}))
registerEndpoint('/api/workspaces/ws1/version', () => ({ version: 1 }))
registerEndpoint('/api/user/workspaces', () => [{ workspaceId: 'ws1', name: 'Product team', role: 'editor' }])
registerEndpoint('/api/user/shared-documents', () => [
  { docId: 'g1', title: 'Shared brief', access: 'edit', workspaceId: 'ws2', workspaceName: 'Agency', lastActive: null },
  { docId: 'g2', title: 'Elsewhere', access: 'view', workspaceId: 'ws9', workspaceName: 'Other', lastActive: null }
])

const SOURCE = '# Report\n\nIntro\n\n## Methods\n\n```\n# not a heading\n```\n\n## Results\n'

const mounted: VueWrapper[] = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
})
beforeEach(() => {
  m.navigateTo.mockReset()
  m.loggedIn = ref(true)
  localStorage.clear()
})

async function mountPanel(props: Partial<{ tab: 'outline' | 'workspace', source: string, view: EditorView | null, workspaceId: string | null, workspaceRole: string | null, docId: string }> = {}) {
  const wrapper = await mountSuspended(EditorLayoutLeftPanel, {
    props: { tab: 'outline', source: SOURCE, view: null, docId: 'cur', workspaceId: null, workspaceRole: null, ...props }
  })
  mounted.push(wrapper)
  return wrapper
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60 && !check(); i++) {
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (!check()) throw new Error(`timed out waiting for ${what}`)
}

describe('left panel tabs', () => {
  it('is a tablist whose selected tab controls the panel', async () => {
    const w = await mountPanel()
    const tabs = w.findAll('[role="tab"]')
    expect(tabs.map(t => t.text())).toEqual(['Outline', 'Workspace'])
    expect(tabs[0]?.attributes('aria-selected')).toBe('true')
    expect(tabs[0]?.attributes('tabindex')).toBe('0')
    expect(tabs[1]?.attributes('tabindex')).toBe('-1')
    const panel = w.find('[role="tabpanel"]')
    expect(panel.attributes('aria-labelledby')).toBe(tabs[0]?.attributes('id'))
    expect(tabs[0]?.attributes('aria-controls')).toBe(panel.attributes('id'))
  })

  it('switches tabs on click and with the arrow keys', async () => {
    const w = await mountPanel()
    await w.find('[data-testid="left-panel-tab-workspace"]').trigger('click')
    await w.find('[data-testid="left-panel-tab-outline"]').trigger('keydown', { key: 'ArrowRight' })
    await w.find('[data-testid="left-panel-tab-outline"]').trigger('keydown', { key: 'End' })
    await w.find('[data-testid="left-panel-tab-outline"]').trigger('keydown', { key: 'ArrowLeft' })
    expect(w.emitted('update:tab')).toEqual([['workspace'], ['workspace'], ['workspace'], ['workspace']])
    await w.find('[data-testid="left-panel-tab-outline"]').trigger('keydown', { key: 'Tab' })
    expect(w.emitted('update:tab')).toHaveLength(4)
  })

  it('closes from its close button', async () => {
    const w = await mountPanel()
    await w.find('[data-testid="left-panel-close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
})

describe('outline tab', () => {
  it('shows the headings as a tree, without the code fence, and reports a click', async () => {
    const w = await mountPanel()
    await until(() => w.findAll('[role="treeitem"]').length === 3, 'the outline')
    const items = w.findAll('[role="treeitem"]')
    expect(items.map(i => i.text())).toEqual(['Report', 'Methods', 'Results'])
    expect(items[0]?.attributes('aria-expanded')).toBe('true')
    expect(items[1]?.attributes('aria-level')).toBe('2')
    await items[2]?.trigger('click')
    const [[heading]] = w.emitted('select-heading') as [[OutlineHeading]]
    expect(heading).toMatchObject({ id: 'results', level: 2, text: 'Results', line: 10 })
    // A click on the entry jumps; the section stays expanded.
    await items[0]?.trigger('click')
    expect(w.findAll('[role="treeitem"]')).toHaveLength(3)
  })

  it('marks the clicked section as current without an editor (preview only)', async () => {
    const w = await mountPanel()
    await until(() => w.findAll('[role="treeitem"]').length === 3, 'the outline')
    await w.findAll('[role="treeitem"]')[1]?.trigger('click')
    expect(w.findAll('[role="treeitem"]')[1]?.attributes('aria-selected')).toBe('true')
  })

  it('follows the cursor in the editor', async () => {
    const view = new EditorView({ state: EditorState.create({ doc: SOURCE }) })
    const w = await mountPanel({ view })
    await until(() => w.findAll('[role="treeitem"]').length === 3, 'the outline')
    expect(w.findAll('[role="treeitem"]')[0]?.attributes('aria-selected')).toBe('true')
    view.dispatch({ selection: { anchor: SOURCE.indexOf('## Results') + 3 } })
    await flushPromises()
    expect(w.findAll('[role="treeitem"]')[2]?.attributes('aria-selected')).toBe('true')
    view.destroy()
  })

  it('has a friendly empty state', async () => {
    const w = await mountPanel({ source: 'Just a paragraph.\n' })
    await until(() => w.find('[data-testid="outline-empty"]').exists(), 'the empty state')
    expect(w.find('[data-testid="outline-empty"]').text()).toContain('No headings yet')
  })
})

describe('workspace tab', () => {
  it('shows a member the folders and documents, the current one selected, and opens another', async () => {
    const w = await mountPanel({ tab: 'workspace', workspaceId: 'ws1', workspaceRole: 'editor' })
    await until(() => w.findAll('[role="treeitem"]').length === 3, 'the workspace tree')
    const items = w.findAll('[role="treeitem"]')
    // The current document's folder starts expanded.
    expect(items.map(i => i.text())).toEqual(['Research', 'Interview notes', 'Roadmap'])
    expect(items[1]?.attributes('aria-selected')).toBe('true')
    expect(w.find('[data-testid="workspace-docs-scope"]').text()).toBe('Product team')
    expect(w.find('[data-testid="workspace-docs-open-explorer"]').attributes('href')).toBe('/w/ws1')
    await items[2]?.trigger('click')
    expect(m.navigateTo).toHaveBeenCalledWith('/d/other')
  })

  it('opens a document in a new tab with Ctrl + click', async () => {
    const open = vi.spyOn(globalThis, 'open').mockImplementation(() => null)
    const w = await mountPanel({ tab: 'workspace', workspaceId: 'ws1', workspaceRole: 'editor' })
    await until(() => w.findAll('[role="treeitem"]').length === 3, 'the workspace tree')
    await w.findAll('[role="treeitem"]')[2]?.trigger('click', { ctrlKey: true })
    expect(open).toHaveBeenCalledWith('/d/other', '_blank', 'noopener')
    expect(m.navigateTo).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('shows a guest only the documents of this workspace shared with them', async () => {
    const w = await mountPanel({ tab: 'workspace', workspaceId: 'ws2', workspaceRole: null, docId: 'g1' })
    await until(() => w.findAll('[role="treeitem"]').length === 1, 'the shared list')
    expect(w.find('[role="treeitem"]').text()).toBe('Shared brief')
    expect(w.find('[data-testid="workspace-docs-open-explorer"]').exists()).toBe(false)
  })

  it('asks a signed-out visitor to sign in', async () => {
    m.loggedIn.value = false
    const w = await mountPanel({ tab: 'workspace', workspaceId: 'ws1', workspaceRole: null })
    expect(w.find('[data-testid="workspace-docs-signed-out"]').exists()).toBe(true)
  })
})

describe('panel state', () => {
  function stubScreen(width: number) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: Number(/(\d+)px/.exec(query)?.[1] ?? 0) <= width,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false
    }))
  }
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function mountState(view: EditorView | null = null) {
    let api!: ReturnType<typeof useEditorLeftPanel>
    const rightSidebar = ref<TabName | null>('navigator')
    const scrollToHeading = vi.fn()
    const Preview = defineComponent({
      setup(_p, { expose }) {
        expose({ scrollToHeading })
        return () => h('div')
      }
    })
    const wrapper = await mountSuspended(defineComponent({
      setup() {
        api = useEditorLeftPanel({
          editorView: shallowRef(view), isMobile: ref(false), rightSidebar, docId: 'cur',
          source: ref(SOURCE), workspaceId: ref(null), workspaceRole: ref(null)
        })
        return () => h('div', [h(Preview, { ref: 'previewPane' })])
      }
    }))
    mounted.push(wrapper)
    await flushPromises()
    return { api, rightSidebar, scrollToHeading }
  }

  it('starts open with the outline on a wide screen, closed on a 1280px one', async () => {
    stubScreen(1600)
    expect((await mountState()).api.open.value).toBe(true)
    stubScreen(1280)
    expect((await mountState()).api.open.value).toBe(false)
  })

  it('remembers the open state and the tab in this browser', async () => {
    stubScreen(1600)
    const first = (await mountState()).api
    first.setTab('workspace')
    first.toggle()
    expect(JSON.parse(localStorage.getItem(LEFT_PANEL_STORAGE_KEY) ?? '{}')).toEqual({ open: false, tab: 'workspace' })
    const again = (await mountState()).api
    expect(again.open.value).toBe(false)
    expect(again.tab.value).toBe('workspace')
  })

  it('toggles with Ctrl+Shift+E', async () => {
    stubScreen(1600)
    const { api } = await mountState()
    const event = new KeyboardEvent('keydown', { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true, cancelable: true })
    globalThis.dispatchEvent(event)
    expect(api.open.value).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true }))
    expect(api.open.value).toBe(true)
  })

  it('jumps the editor and the preview to a heading and closes the phone sheet', async () => {
    stubScreen(1600)
    const view = new EditorView({ state: EditorState.create({ doc: SOURCE }) })
    vi.spyOn(view, 'focus').mockImplementation(() => {})
    const { api, rightSidebar, scrollToHeading } = await mountState(view)
    api.jumpToHeading({ id: 'results', level: 2, text: 'Results', line: 10 })
    expect(view.state.selection.main.head).toBe(SOURCE.indexOf('## Results') + '## Results'.length)
    expect(scrollToHeading).toHaveBeenCalledWith('results')
    expect(rightSidebar.value).toBeNull()
    view.destroy()
  })

  it('hands the panel its props and listeners', async () => {
    stubScreen(1600)
    const { api } = await mountState()
    expect(api.panelProps.value).toMatchObject({ tab: 'outline', source: SOURCE, docId: 'cur', workspaceId: null })
    api.panelProps.value['onUpdate:tab']('workspace')
    expect(api.tab.value).toBe('workspace')
  })
})

describe('left panel host', () => {
  it('sits beside the editor from xl and lies over it below, closing on Escape there', async () => {
    const panel = {
      'tab': 'outline' as const, 'source': SOURCE, 'view': null, 'docId': 'cur', 'workspaceId': null, 'workspaceRole': null,
      'onUpdate:tab': () => {}, 'onSelectHeading': () => {}
    }
    const inline = await mountSuspended(EditorLayoutLeftPanelHost, { props: { open: true, inline: true, panel } })
    mounted.push(inline)
    expect(inline.find('[data-testid="left-panel-host"]').attributes('data-overlay')).toBeUndefined()
    await inline.find('[data-testid="left-panel-host"]').trigger('keydown', { key: 'Escape' })
    expect(inline.emitted('close')).toBeUndefined()

    const overlay = await mountSuspended(EditorLayoutLeftPanelHost, { props: { open: true, inline: false, panel } })
    mounted.push(overlay)
    expect(overlay.find('[data-testid="left-panel-host"]').attributes('data-overlay')).toBe('true')
    await overlay.find('[data-testid="left-panel-host"]').trigger('keydown', { key: 'Escape' })
    expect(overlay.emitted('close')).toHaveLength(1)
    await overlay.find('[data-testid="left-panel-close"]').trigger('click')
    expect(overlay.emitted('close')).toHaveLength(2)
  })
})
