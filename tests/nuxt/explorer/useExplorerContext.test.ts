import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import { docItem, folderItem, type ExplorerItem } from '~/utils/explorer/model'
import type { ExplorerScope } from '~/composables/explorer/useExplorerData'
import { doc, folder } from './fixtures'

// "Use as AI context" in the explorer: the menu entry (desktop submenu,
// mobile toggle, hidden for read-only users) and the composable that marks
// or unmarks a document and reports the outcome.

const m = vi.hoisted(() => ({
  mutateAsync: vi.fn()
}))

mockNuxtImport('useI18n', () => () => ({
  t: (key: string, params?: Record<string, unknown>) => params ? `${key} ${JSON.stringify(params)}` : key
}))
vi.mock('~/queries/projectContext', () => ({
  useSetContextScope: () => ({ mutateAsync: m.mutateAsync })
}))

// eslint-disable-next-line import/first -- mocks must be hoisted above the imports they replace
import { useExplorerContextScope } from '~/composables/explorer/useExplorerContextScope'
// eslint-disable-next-line import/first
import { useExplorerMenu } from '~/composables/explorer/useExplorerMenu'

beforeEach(() => {
  m.mutateAsync.mockReset()
})

function scopeSetup(scope: ExplorerScope = { kind: 'workspace', workspaceId: 'ws1' }) {
  const afterChange = vi.fn(async () => {})
  const announce = vi.fn()
  const handleError = vi.fn(async () => true)
  const api = useExplorerContextScope({ scope: ref(scope), afterChange, announce, handleError })
  return { api, afterChange, announce, handleError }
}

describe('useExplorerContextScope', () => {
  it('marks a document, refreshes and announces it as on', async () => {
    m.mutateAsync.mockResolvedValue({})
    const { api, afterChange, announce } = scopeSetup()
    await api.setContextScope(docItem(doc('d1', null, 'Bible')), 'folder')
    expect(m.mutateAsync).toHaveBeenCalledWith({ docId: 'd1', scope: 'folder' })
    expect(afterChange).toHaveBeenCalledOnce()
    expect(announce).toHaveBeenCalledWith('explorer.announce.contextOn {"name":"Bible"}')
  })

  it('unmarking announces off', async () => {
    m.mutateAsync.mockResolvedValue({})
    const { api, announce } = scopeSetup()
    await api.setContextScope(docItem(doc('d1', null, 'Bible')), null)
    expect(m.mutateAsync).toHaveBeenCalledWith({ docId: 'd1', scope: null })
    expect(announce).toHaveBeenCalledWith('explorer.announce.contextOff {"name":"Bible"}')
  })

  it('ignores folders', async () => {
    const { api, afterChange } = scopeSetup()
    await api.setContextScope(folderItem(folder('f1')), 'all')
    expect(m.mutateAsync).not.toHaveBeenCalled()
    expect(afterChange).not.toHaveBeenCalled()
  })

  it('hands a failure to the error handler without refreshing or announcing', async () => {
    const err = new Error('nope')
    m.mutateAsync.mockRejectedValue(err)
    const { api, afterChange, announce, handleError } = scopeSetup()
    await api.setContextScope(docItem(doc('d1')), 'all')
    expect(handleError).toHaveBeenCalledWith(err, 'explorer.error.context')
    expect(afterChange).not.toHaveBeenCalled()
    expect(announce).not.toHaveBeenCalled()
  })

  it('"all" means the workspace in a workspace and all personal documents otherwise', () => {
    expect(scopeSetup({ kind: 'workspace', workspaceId: 'ws1' }).api.inWorkspace.value).toBe(true)
    expect(scopeSetup({ kind: 'personal' }).api.inWorkspace.value).toBe(false)
  })
})

function menuSetup(over: { isMobile?: boolean, inWorkspace?: boolean, canWrite?: boolean } = {}) {
  const setContextScope = vi.fn(async () => {})
  const run = vi.fn()
  const menu = useExplorerMenu({
    perms: ref({ canWrite: over.canWrite ?? true, isAdmin: true }),
    canPaste: ref(false),
    isMobile: ref(over.isMobile ?? false),
    sort: ref('updated' as never),
    dir: ref('desc' as const),
    setSort: vi.fn(),
    run,
    context: { setContextScope, inWorkspace: ref(over.inWorkspace ?? true) }
  })
  return { menu, setContextScope, run }
}

type MenuEntry = { label?: string, children?: MenuEntry[][], checked?: boolean, onSelect?: () => void, onUpdateChecked?: () => void }
function contextEntry(items: unknown[][]): MenuEntry | undefined {
  return (items.flat() as MenuEntry[]).find(i => i.label === 'explorer.action.aiContext' || i.label === 'explorer.context.stop')
}

function docWith(scope: 'folder' | 'all' | null | undefined): ExplorerItem {
  return docItem({ ...doc('d1'), contextScope: scope })
}

describe('"Use as AI context" menu entry (desktop)', () => {
  it('offers off / folder / workspace as checkboxes, the current one checked', () => {
    const { menu } = menuSetup()
    const entry = contextEntry(menu.menuItems([docWith('folder')]))
    const choices = entry?.children?.[0] ?? []
    expect(choices.map(c => c.label)).toEqual(['explorer.context.off', 'explorer.context.folder', 'explorer.context.all'])
    expect(choices.map(c => c.checked)).toEqual([false, true, false])
  })

  it('treats an unmarked document as "off"', () => {
    const { menu } = menuSetup()
    const choices = contextEntry(menu.menuItems([docWith(undefined)]))?.children?.[0] ?? []
    expect(choices.map(c => c.checked)).toEqual([true, false, false])
  })

  it('words the whole-scope choice for personal documents', () => {
    const { menu } = menuSetup({ inWorkspace: false })
    const choices = contextEntry(menu.menuItems([docWith(null)]))?.children?.[0] ?? []
    expect(choices[2]?.label).toBe('explorer.context.allPersonal')
  })

  it('choosing a scope marks that document', () => {
    const { menu, setContextScope } = menuSetup()
    const target = docWith(null)
    contextEntry(menu.menuItems([target]))?.children?.[0]?.[2]?.onUpdateChecked?.()
    expect(setContextScope).toHaveBeenCalledWith(target, 'all')
  })

  it('is not offered to a read-only user, and not for folders', () => {
    expect(contextEntry(menuSetup({ canWrite: false }).menu.menuItems([docItem({ ...doc('d1'), isOwner: false })]))).toBeUndefined()
    expect(contextEntry(menuSetup().menu.menuItems([folderItem(folder('f'))]))).toBeUndefined()
  })

  it('other entries still run their command on the targets', () => {
    const { menu, run } = menuSetup()
    const target = docWith(null)
    const open = menu.menuItems([target]).flat().find(i => i.label === 'explorer.action.open') as MenuEntry
    open.onSelect?.()
    expect(run).toHaveBeenCalledWith('open', [target])
  })
})

describe('"Use as AI context" menu entry (mobile)', () => {
  it('toggles on for the folder when unmarked', () => {
    const { menu, setContextScope } = menuSetup({ isMobile: true })
    const target = docWith(null)
    const entry = contextEntry(menu.menuItems([target]))
    expect(entry?.label).toBe('explorer.action.aiContext')
    expect(entry?.children).toBeUndefined()
    entry?.onSelect?.()
    expect(setContextScope).toHaveBeenCalledWith(target, 'folder')
  })

  it('offers to stop and unmarks when already marked', () => {
    const { menu, setContextScope } = menuSetup({ isMobile: true })
    const target = docWith('all')
    const entry = contextEntry(menu.menuItems([target]))
    expect(entry?.label).toBe('explorer.context.stop')
    entry?.onSelect?.()
    expect(setContextScope).toHaveBeenCalledWith(target, null)
  })
})
