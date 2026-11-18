import { useInfiniteQuery, useQuery, useQueryCache } from '@pinia/colada'
import type { DocRow, FolderRow } from '~/utils/explorer/model'
import type { DocListSort } from '~~/shared/api/explorer'

// The explorer's server state: the scope's folder tree, the current folder's
// documents (pages of 100, keyset cursor) and the change counter. The counter
// is polled every 15 s while the tab is visible and on focus; when another
// person changed something in the scope, every explorer query of the scope is
// invalidated, which refetches what is on screen. The component keeps its own
// state (selection, scroll, an inline rename) across refetches.

export type ExplorerScope = { kind: 'workspace', workspaceId: string } | { kind: 'personal' }

export const explorerKeys = {
  root: ['explorer'] as const,
  scope: (s: ExplorerScope) => ['explorer', s.kind === 'workspace' ? `ws:${s.workspaceId}` : 'personal'] as const,
  folders: (s: ExplorerScope) => [...explorerKeys.scope(s), 'folders'] as const,
  docs: (s: ExplorerScope, params: DocListParams) => [...explorerKeys.scope(s), 'docs', params.folder, params.sort, params.dir, params.q] as const
}

export interface DocListParams {
  /** 'root', 'all' or a folder id. */
  folder: string
  sort: DocListSort
  dir: 'asc' | 'desc'
  q: string
}

interface DocPage { items: DocRow[], total: number, nextCursor: string | null }

const PAGE = 100
const POLL_MS = 15_000

async function fetchFolders(scope: ExplorerScope, signal: AbortSignal): Promise<FolderRow[]> {
  const res = scope.kind === 'workspace'
    ? await apiFetch('/api/workspaces/:wsId/folders', { path: { wsId: scope.workspaceId }, signal })
    : await apiFetch('/api/user/folders', { signal })
  return res.folders
}

async function fetchDocs(scope: ExplorerScope, params: DocListParams, cursor: string | null, signal: AbortSignal): Promise<DocPage> {
  const query = {
    folder: params.folder,
    sort: params.sort,
    dir: params.dir,
    limit: PAGE,
    ...(params.q ? { q: params.q } : {}),
    ...(cursor ? { cursor } : {})
  }
  return scope.kind === 'workspace'
    ? apiFetch('/api/workspaces/:wsId/documents', { path: { wsId: scope.workspaceId }, query, signal })
    : apiFetch('/api/user/personal-documents', { query, signal })
}

async function fetchVersion(scope: ExplorerScope): Promise<number> {
  const res = scope.kind === 'workspace'
    ? await apiFetch('/api/workspaces/:wsId/version', { path: { wsId: scope.workspaceId } })
    : await apiFetch('/api/user/explorer-version')
  return res.version
}

export function useExplorerData(scope: Ref<ExplorerScope>, params: Ref<DocListParams>) {
  const cache = useQueryCache()

  const folders = useQuery({
    key: () => explorerKeys.folders(scope.value),
    query: ({ signal }) => fetchFolders(scope.value, signal),
    enabled: () => import.meta.client,
    staleTime: 0
  })

  const docs = useInfiniteQuery<DocPage, Error, string | null>({
    key: () => explorerKeys.docs(scope.value, params.value),
    query: ({ signal, pageParam }) => fetchDocs(scope.value, params.value, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last: DocPage) => last.nextCursor,
    enabled: () => import.meta.client,
    staleTime: 0
  })

  const docRows = computed<DocRow[]>(() => docs.data.value?.pages.flatMap(p => p.items) ?? [])
  const total = computed(() => docs.data.value?.pages[0]?.total ?? 0)

  /** Refetch everything this scope shows (after an own change, or someone else's). */
  async function refresh(): Promise<void> {
    await cache.invalidateQueries({ key: explorerKeys.scope(scope.value) }).catch(() => {})
  }

  // Change counter: someone else changed the scope -> refetch.
  let lastVersion: number | null = null
  async function checkVersion(): Promise<void> {
    if (import.meta.server || document.visibilityState !== 'visible') return
    try {
      const v = await fetchVersion(scope.value)
      if (lastVersion !== null && v !== lastVersion) await refresh()
      lastVersion = v
    } catch { /* offline or gone: the next poll tries again */ }
  }
  watch(scope, () => {
    lastVersion = null
    void checkVersion()
  }, { deep: true })
  if (import.meta.client) {
    useIntervalFn(() => void checkVersion(), POLL_MS)
    useEventListener(window, 'focus', () => void checkVersion())
    useEventListener(document, 'visibilitychange', () => void checkVersion())
    onMounted(() => void checkVersion())
  }

  /** Our own change: refetch now, and take the new counter so the poll doesn't refetch again. */
  async function afterChange(): Promise<void> {
    await refresh()
    try {
      lastVersion = await fetchVersion(scope.value)
    } catch { /* the poll catches up */ }
  }

  return { folders, docs, docRows, total, refresh, afterChange }
}
