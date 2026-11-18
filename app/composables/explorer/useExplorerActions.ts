import { apiErrorData } from '~/utils/api/errors'
import type { ExplorerItem, FolderRow } from '~/utils/explorer/model'
import type { ExplorerScope } from './useExplorerData'

// What the explorer does on the server: create, rename, move, delete. Every
// call refetches the scope afterwards (`afterChange`). An item someone else
// moved or deleted meanwhile answers `folder/not-found` / `docs/not-found`
// (or a per-item result with that code): the person gets one friendly toast
// and the list refreshes. Moves can be undone from their toast (or Ctrl+Z
// while it shows) by moving the items back where they were.

/** Codes meaning "the list you acted on is out of date". */
const STALE_CODES = new Set(['folder/not-found', 'docs/not-found', 'folder/cycle'])

export interface BulkResult { id: string, kind: 'doc' | 'folder', ok: boolean, code?: string }

interface Placement { item: ExplorerItem, from: string | null }

export function useExplorerActions(opts: {
  scope: Ref<ExplorerScope>
  afterChange: () => Promise<void>
  announce: (text: string) => void
}) {
  const { t } = useI18n()
  const toast = useToast()
  const { showError } = useErrorHandler()

  const workspaceId = computed(() => opts.scope.value.kind === 'workspace' ? opts.scope.value.workspaceId : null)

  function staleToast(): void {
    toast.add({ title: t('explorer.stale'), icon: 'i-lucide-refresh-cw', color: 'neutral' })
  }

  /** A failed call: stale -> friendly toast + refresh; anything else -> the error toast. Returns true when it was stale. */
  async function handleError(e: unknown, fallbackKey: string): Promise<boolean> {
    const code = apiErrorData(e)?.code
    if (typeof code === 'string' && STALE_CODES.has(code)) {
      staleToast()
      await opts.afterChange()
      return true
    }
    showError(fallbackKey, e)
    return false
  }

  /** Per-item results of a bulk call: refreshes, says what failed. */
  async function settle(results: BulkResult[], doneKey: string, n: number): Promise<number> {
    await opts.afterChange()
    const failed = results.filter(r => !r.ok)
    if (failed.some(r => r.code && STALE_CODES.has(r.code))) staleToast()
    else if (failed.length > 0) toast.add({ title: t('explorer.someFailed', { n: failed.length }, failed.length), icon: 'i-lucide-alert-circle', color: 'error' })
    const ok = results.length - failed.length
    if (ok > 0) opts.announce(t(doneKey, { n: ok }, ok))
    void n
    return ok
  }

  async function createFolder(name: string, parentId: string | null): Promise<FolderRow | null> {
    try {
      const body = { name, parentId }
      const res = workspaceId.value
        ? await apiFetch('/api/workspaces/:wsId/folders', { method: 'post', path: { wsId: workspaceId.value }, body })
        : await apiFetch('/api/user/folders', { method: 'post', body })
      await opts.afterChange()
      opts.announce(t('explorer.announce.folderCreated', { name }))
      return res.folder
    } catch (e) {
      await handleError(e, 'explorer.error.createFolder')
      return null
    }
  }

  async function renameItem(item: ExplorerItem, name: string): Promise<boolean> {
    try {
      if (item.kind === 'folder') {
        await apiFetch('/api/folders/:folderId', { method: 'patch', path: { folderId: item.id }, body: { name } })
      } else {
        await apiFetch('/api/docs/:docId/title', { method: 'put', path: { docId: item.id }, body: { title: name } })
      }
      await opts.afterChange()
      opts.announce(t('explorer.announce.renamed', { name }))
      return true
    } catch (e) {
      await handleError(e, 'explorer.error.rename')
      return false
    }
  }

  async function moveRaw(items: readonly ExplorerItem[], target: string | null): Promise<BulkResult[]> {
    const res = await apiFetch('/api/folders/bulk-move', {
      method: 'post',
      body: {
        workspaceId: workspaceId.value,
        targetFolderId: target,
        folderIds: items.filter(i => i.kind === 'folder').map(i => i.id),
        docIds: items.filter(i => i.kind === 'doc').map(i => i.id)
      }
    })
    return res.results as BulkResult[]
  }

  const undoable = shallowRef<{ placements: Placement[], until: number } | null>(null)

  async function undoLastMove(): Promise<void> {
    const last = undoable.value
    if (!last || Date.now() > last.until) return
    undoable.value = null
    const byFrom = new Map<string | null, ExplorerItem[]>()
    for (const p of last.placements) byFrom.set(p.from, [...(byFrom.get(p.from) ?? []), p.item])
    const results: BulkResult[] = []
    try {
      for (const [from, items] of byFrom) results.push(...await moveRaw(items, from))
    } catch (e) {
      await handleError(e, 'explorer.error.move')
      return
    }
    await settle(results, 'explorer.announce.undone', results.length)
  }

  /** Move items into a folder of this scope (null = the root). Offers undo. */
  async function moveItems(items: readonly ExplorerItem[], target: string | null, targetName: string): Promise<void> {
    if (items.length === 0) return
    const placements: Placement[] = items.map(item => ({ item, from: item.kind === 'folder' ? item.folder.parentId : item.doc.folderId }))
    let results: BulkResult[]
    try {
      results = await moveRaw(items, target)
    } catch (e) {
      await handleError(e, 'explorer.error.move')
      return
    }
    const moved = new Set(results.filter(r => r.ok).map(r => r.id))
    const ok = await settle(results, 'explorer.announce.moved', items.length)
    if (ok === 0) return
    undoable.value = { placements: placements.filter(p => moved.has(p.item.id)), until: Date.now() + 8000 }
    toast.add({
      title: t('explorer.movedTo', { n: ok, name: targetName }, ok),
      icon: 'i-lucide-folder-input',
      color: 'neutral',
      duration: 8000,
      actions: [{ label: t('explorer.undo'), color: 'neutral', variant: 'outline', onClick: () => void undoLastMove() }]
    })
  }

  /** Move documents to another workspace (null = personal). Members of the old workspace lose access. */
  async function moveToWorkspace(items: readonly ExplorerItem[], target: string | null): Promise<void> {
    const docIds = items.filter(i => i.kind === 'doc').map(i => i.id)
    if (docIds.length === 0) return
    try {
      const res = await apiFetch('/api/documents/bulk', { method: 'post', body: { action: 'move-workspace', docIds, workspaceId: target } })
      await settle(res.results as BulkResult[], 'explorer.announce.movedWorkspace', docIds.length)
    } catch (e) {
      await handleError(e, 'explorer.error.move')
    }
  }

  /** Delete folders (each with everything inside) and documents. */
  async function deleteItems(items: readonly ExplorerItem[]): Promise<void> {
    const results: BulkResult[] = []
    for (const folder of items.filter(i => i.kind === 'folder')) {
      try {
        await apiFetch('/api/folders/:folderId', { method: 'delete', path: { folderId: folder.id } })
        results.push({ id: folder.id, kind: 'folder', ok: true })
      } catch (e) {
        const code = apiErrorData(e)?.code
        if (code === 'folder/delete-blocked') {
          showError('explorer.error.deleteBlocked', e)
          results.push({ id: folder.id, kind: 'folder', ok: false, code: 'folder/delete-blocked' })
        } else {
          results.push({ id: folder.id, kind: 'folder', ok: false, code: typeof code === 'string' ? code : 'internal' })
        }
      }
    }
    const docIds = items.filter(i => i.kind === 'doc').map(i => i.id)
    if (docIds.length > 0) {
      try {
        const res = await apiFetch('/api/documents/bulk', { method: 'post', body: { action: 'delete', docIds } })
        results.push(...res.results as BulkResult[])
      } catch (e) {
        await handleError(e, 'explorer.error.delete')
      }
    }
    await settle(results.filter(r => r.code !== 'folder/delete-blocked'), 'explorer.announce.deleted', items.length)
  }

  return { createFolder, renameItem, moveItems, moveToWorkspace, deleteItems, undoLastMove, undoable, handleError }
}
