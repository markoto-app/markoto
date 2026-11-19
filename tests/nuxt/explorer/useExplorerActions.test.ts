import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import { docItem, folderItem } from '~/utils/explorer/model'
import type { ExplorerScope } from '~/composables/explorer/useExplorerData'
import { doc, folder } from './fixtures'

// What the explorer does on the server: every call goes through `apiFetch`
// (mocked here), refreshes the scope and announces / toasts the outcome.

const m = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toastAdd: vi.fn(),
  showError: vi.fn()
}))

mockNuxtImport('apiFetch', () => m.apiFetch)
mockNuxtImport('useToast', () => () => ({ add: m.toastAdd }))
mockNuxtImport('useErrorHandler', () => () => ({ showError: m.showError }))
mockNuxtImport('useI18n', () => () => ({
  t: (key: string, params?: Record<string, unknown>) => params ? `${key} ${JSON.stringify(params)}` : key
}))

// eslint-disable-next-line import/first -- mockNuxtImport must be hoisted above the import it mocks
import { useExplorerActions } from '~/composables/explorer/useExplorerActions'

function apiError(code: string) {
  return Object.assign(new Error(code), { data: { statusCode: 409, message: code, data: { code } } })
}

function setup(scope: ExplorerScope = { kind: 'workspace', workspaceId: 'ws1' }) {
  const afterChange = vi.fn(async () => {})
  const announce = vi.fn()
  const actions = useExplorerActions({ scope: ref(scope), afterChange, announce })
  return { actions, afterChange, announce }
}

function toastTitles(): string[] {
  return m.toastAdd.mock.calls.map(c => (c[0] as { title: string }).title)
}

beforeEach(() => {
  m.apiFetch.mockReset()
  m.toastAdd.mockReset()
  m.showError.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createFolder', () => {
  it('creates in a workspace, refreshes and announces', async () => {
    const created = folder('new')
    m.apiFetch.mockResolvedValueOnce({ folder: created })
    const { actions, afterChange, announce } = setup()
    expect(await actions.createFolder('Plans', 'p1')).toEqual(created)
    expect(m.apiFetch).toHaveBeenCalledWith('/api/workspaces/:wsId/folders', { method: 'post', path: { wsId: 'ws1' }, body: { name: 'Plans', parentId: 'p1' } })
    expect(afterChange).toHaveBeenCalledOnce()
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('explorer.announce.folderCreated'))
  })

  it('creates a personal folder outside a workspace', async () => {
    m.apiFetch.mockResolvedValueOnce({ folder: folder('p') })
    const { actions } = setup({ kind: 'personal' })
    await actions.createFolder('Mine', null)
    expect(m.apiFetch).toHaveBeenCalledWith('/api/user/folders', { method: 'post', body: { name: 'Mine', parentId: null } })
  })

  it('a stale parent gives the stale toast and refreshes', async () => {
    m.apiFetch.mockRejectedValueOnce(apiError('folder/not-found'))
    const { actions, afterChange } = setup()
    expect(await actions.createFolder('X', 'gone')).toBeNull()
    expect(toastTitles()).toEqual(['explorer.stale'])
    expect(afterChange).toHaveBeenCalledOnce()
    expect(m.showError).not.toHaveBeenCalled()
  })

  it('any other error shows the error toast without refreshing', async () => {
    const err = apiError('folder/name-taken')
    m.apiFetch.mockRejectedValueOnce(err)
    const { actions, afterChange } = setup()
    expect(await actions.createFolder('X', null)).toBeNull()
    expect(m.showError).toHaveBeenCalledWith('explorer.error.createFolder', err)
    expect(afterChange).not.toHaveBeenCalled()
  })
})

describe('renameItem', () => {
  it('renames a folder through the folder route', async () => {
    m.apiFetch.mockResolvedValueOnce({})
    const { actions, announce } = setup()
    expect(await actions.renameItem(folderItem(folder('f1')), 'New')).toBe(true)
    expect(m.apiFetch).toHaveBeenCalledWith('/api/folders/:folderId', { method: 'patch', path: { folderId: 'f1' }, body: { name: 'New' } })
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('explorer.announce.renamed'))
  })

  it('renames a document through its title', async () => {
    m.apiFetch.mockResolvedValueOnce({})
    const { actions } = setup()
    expect(await actions.renameItem(docItem(doc('d1')), 'Title')).toBe(true)
    expect(m.apiFetch).toHaveBeenCalledWith('/api/docs/:docId/title', { method: 'put', path: { docId: 'd1' }, body: { title: 'Title' } })
  })

  it('a document deleted meanwhile is stale', async () => {
    m.apiFetch.mockRejectedValueOnce(apiError('docs/not-found'))
    const { actions, afterChange } = setup()
    expect(await actions.renameItem(docItem(doc('d1')), 'T')).toBe(false)
    expect(toastTitles()).toEqual(['explorer.stale'])
    expect(afterChange).toHaveBeenCalledOnce()
  })

  it('an unknown failure shows the rename error', async () => {
    const err = new Error('boom')
    m.apiFetch.mockRejectedValueOnce(err)
    const { actions } = setup()
    expect(await actions.renameItem(docItem(doc('d1')), 'T')).toBe(false)
    expect(m.showError).toHaveBeenCalledWith('explorer.error.rename', err)
  })
})

describe('moveItems', () => {
  it('does nothing for an empty list', async () => {
    const { actions, afterChange } = setup()
    await actions.moveItems([], 'f1', 'F')
    expect(m.apiFetch).not.toHaveBeenCalled()
    expect(afterChange).not.toHaveBeenCalled()
  })

  it('moves folders and documents in one call and offers undo', async () => {
    const f = folderItem(folder('f1', 'old'))
    const d = docItem(doc('d1', null))
    m.apiFetch.mockResolvedValueOnce({ results: [{ id: 'f1', kind: 'folder', ok: true }, { id: 'd1', kind: 'doc', ok: true }] })
    const { actions, announce, afterChange } = setup()
    await actions.moveItems([f, d], 'target', 'Target')
    expect(m.apiFetch).toHaveBeenCalledWith('/api/folders/bulk-move', {
      method: 'post',
      body: { workspaceId: 'ws1', targetFolderId: 'target', folderIds: ['f1'], docIds: ['d1'] }
    })
    expect(afterChange).toHaveBeenCalledOnce()
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('explorer.announce.moved'))
    const toast = m.toastAdd.mock.calls[0]![0] as { title: string, duration: number, actions: Array<{ onClick: () => void }> }
    expect(toast.title).toContain('explorer.movedTo')
    expect(toast.duration).toBe(8000)
    expect(actions.undoable.value?.placements.map(p => [p.item.id, p.from])).toEqual([['f1', 'old'], ['d1', null]])

    // Undo from the toast moves each item back where it came from, grouped by origin.
    m.apiFetch.mockResolvedValue({ results: [{ id: 'x', kind: 'doc', ok: true }] })
    toast.actions[0]!.onClick()
    await vi.waitFor(() => expect(announce).toHaveBeenCalledWith(expect.stringContaining('explorer.announce.undone')))
    const undoTargets = m.apiFetch.mock.calls.slice(1).map(c => (c[1] as { body: { targetFolderId: string | null } }).body.targetFolderId)
    expect(undoTargets).toEqual(['old', null])
    expect(actions.undoable.value).toBeNull()
  })

  it('only offers to undo what moved; a full failure offers nothing', async () => {
    m.apiFetch.mockResolvedValueOnce({ results: [{ id: 'd1', kind: 'doc', ok: true }, { id: 'd2', kind: 'doc', ok: false, code: 'docs/forbidden' }] })
    const { actions } = setup()
    await actions.moveItems([docItem(doc('d1')), docItem(doc('d2'))], null, 'Root')
    expect(actions.undoable.value?.placements.map(p => p.item.id)).toEqual(['d1'])
    expect(toastTitles()[0]).toContain('explorer.someFailed')

    m.toastAdd.mockReset()
    actions.undoable.value = null
    m.apiFetch.mockResolvedValueOnce({ results: [{ id: 'd1', kind: 'doc', ok: false, code: 'docs/forbidden' }] })
    await actions.moveItems([docItem(doc('d1'))], null, 'Root')
    expect(actions.undoable.value).toBeNull()
    expect(toastTitles()).toHaveLength(1)
  })

  it('a per-item stale result gives the stale toast', async () => {
    m.apiFetch.mockResolvedValueOnce({ results: [{ id: 'f1', kind: 'folder', ok: false, code: 'folder/cycle' }] })
    const { actions, announce } = setup()
    await actions.moveItems([folderItem(folder('f1'))], 'f2', 'F2')
    expect(toastTitles()).toEqual(['explorer.stale'])
    expect(announce).not.toHaveBeenCalled()
  })

  it('a thrown cycle error is stale and refreshes', async () => {
    m.apiFetch.mockRejectedValueOnce(apiError('folder/cycle'))
    const { actions, afterChange } = setup()
    await actions.moveItems([folderItem(folder('f1'))], 'f2', 'F2')
    expect(toastTitles()).toEqual(['explorer.stale'])
    expect(afterChange).toHaveBeenCalledOnce()
    expect(actions.undoable.value).toBeNull()
  })

  it('sends a null workspace in the personal scope', async () => {
    m.apiFetch.mockResolvedValueOnce({ results: [] })
    const { actions } = setup({ kind: 'personal' })
    await actions.moveItems([docItem(doc('d1'))], null, 'Root')
    expect((m.apiFetch.mock.calls[0]![1] as { body: { workspaceId: unknown } }).body.workspaceId).toBeNull()
  })
})

describe('undoLastMove', () => {
  it('does nothing without a recent move', async () => {
    const { actions } = setup()
    await actions.undoLastMove()
    expect(m.apiFetch).not.toHaveBeenCalled()
  })

  it('does nothing once the undo window passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    m.apiFetch.mockResolvedValueOnce({ results: [{ id: 'd1', kind: 'doc', ok: true }] })
    const { actions } = setup()
    await actions.moveItems([docItem(doc('d1', 'a'))], 'b', 'B')
    vi.setSystemTime(Date.now() + 9000)
    await actions.undoLastMove()
    expect(m.apiFetch).toHaveBeenCalledOnce()
  })

  it('a failing undo shows the move error', async () => {
    m.apiFetch.mockResolvedValueOnce({ results: [{ id: 'd1', kind: 'doc', ok: true }] })
    const { actions, announce } = setup()
    await actions.moveItems([docItem(doc('d1', 'a'))], 'b', 'B')
    const err = new Error('offline')
    m.apiFetch.mockRejectedValueOnce(err)
    await actions.undoLastMove()
    expect(m.showError).toHaveBeenCalledWith('explorer.error.move', err)
    expect(announce).not.toHaveBeenCalledWith(expect.stringContaining('undone'))
  })
})

describe('moveToWorkspace', () => {
  it('ignores folders and does nothing without documents', async () => {
    const { actions } = setup()
    await actions.moveToWorkspace([folderItem(folder('f1'))], 'ws2')
    expect(m.apiFetch).not.toHaveBeenCalled()
  })

  it('moves the documents and settles their results', async () => {
    m.apiFetch.mockResolvedValueOnce({ results: [{ id: 'd1', kind: 'doc', ok: true }] })
    const { actions, announce } = setup()
    await actions.moveToWorkspace([docItem(doc('d1')), folderItem(folder('f1'))], null)
    expect(m.apiFetch).toHaveBeenCalledWith('/api/documents/bulk', { method: 'post', body: { action: 'move-workspace', docIds: ['d1'], workspaceId: null } })
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('explorer.announce.movedWorkspace'))
  })

  it('an error shows the move error', async () => {
    const err = apiError('plan/limit-reached')
    m.apiFetch.mockRejectedValueOnce(err)
    const { actions } = setup()
    await actions.moveToWorkspace([docItem(doc('d1'))], 'ws2')
    expect(m.showError).toHaveBeenCalledWith('explorer.error.move', err)
  })
})

describe('deleteItems', () => {
  it('deletes folders one by one and documents in bulk', async () => {
    m.apiFetch
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ results: [{ id: 'd1', kind: 'doc', ok: true }] })
    const { actions, announce, afterChange } = setup()
    await actions.deleteItems([folderItem(folder('f1')), docItem(doc('d1'))])
    expect(m.apiFetch).toHaveBeenNthCalledWith(1, '/api/folders/:folderId', { method: 'delete', path: { folderId: 'f1' } })
    expect(m.apiFetch).toHaveBeenNthCalledWith(2, '/api/documents/bulk', { method: 'post', body: { action: 'delete', docIds: ['d1'] } })
    expect(afterChange).toHaveBeenCalledOnce()
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('"n":2'))
  })

  it('a blocked folder delete shows its own error and is not counted as a failure', async () => {
    const err = apiError('folder/delete-blocked')
    m.apiFetch.mockRejectedValueOnce(err)
    const { actions, announce } = setup()
    await actions.deleteItems([folderItem(folder('f1'))])
    expect(m.showError).toHaveBeenCalledWith('explorer.error.deleteBlocked', err)
    expect(m.toastAdd).not.toHaveBeenCalled()
    expect(announce).not.toHaveBeenCalled()
  })

  it('other folder failures count as failed (stale or not)', async () => {
    m.apiFetch
      .mockRejectedValueOnce(apiError('folder/not-found'))
      .mockRejectedValueOnce(new Error('network'))
    const { actions } = setup()
    await actions.deleteItems([folderItem(folder('f1')), folderItem(folder('f2'))])
    expect(toastTitles()).toEqual(['explorer.stale'])

    m.toastAdd.mockReset()
    m.apiFetch.mockRejectedValueOnce(new Error('network'))
    await actions.deleteItems([folderItem(folder('f3'))])
    expect(toastTitles()[0]).toContain('explorer.someFailed')
  })

  it('a failing bulk document delete shows the delete error', async () => {
    const err = new Error('down')
    m.apiFetch.mockRejectedValueOnce(err)
    const { actions, afterChange } = setup()
    await actions.deleteItems([docItem(doc('d1'))])
    expect(m.showError).toHaveBeenCalledWith('explorer.error.delete', err)
    expect(afterChange).toHaveBeenCalledOnce()
  })
})
