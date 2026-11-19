// A document's project context (`/api/docs/:docId/context`): whether it is
// itself marked as AI context, which context documents reach the AI in it
// and which are attached to it. Read by the document panel; changed by its
// controls and by the explorer's "Use as AI context" menu.
import { useMutation, useQuery, useQueryCache } from '@pinia/colada'
import { apiFetch } from '~/utils/api/client'
import { invalidate } from './invalidate'
import type { ContextScope } from '~~/shared/config/projectContext'

const projectContextKeys = {
  root: ['project-context'] as const,
  doc: (docId: string) => [...projectContextKeys.root, docId] as const
}

/** Loaded on the client for a signed-in reader while `active` (the panel is open). */
export function useProjectContext(docId: MaybeRefOrGetter<string>, active: MaybeRefOrGetter<boolean> = true) {
  const { loggedIn } = useUserSession()
  return useQuery(() => ({
    key: projectContextKeys.doc(toValue(docId)),
    query: ({ signal }) => apiFetch('/api/docs/:docId/context', { path: { docId: toValue(docId) }, signal }),
    enabled: import.meta.client && loggedIn.value && toValue(active)
  }))
}

// Marking or attaching changes the context of other documents too (every
// document of the folder or workspace), so every cached entry goes stale.
export function useSetContextScope() {
  const cache = useQueryCache()
  return useMutation({
    mutation: ({ docId, scope }: { docId: string, scope: ContextScope | null }) =>
      apiFetch('/api/docs/:docId/context/scope', { method: 'put', path: { docId }, body: { scope } }),
    onSuccess: () => invalidate(cache, projectContextKeys.root)
  })
}

export function useAddContextLink() {
  const cache = useQueryCache()
  return useMutation({
    mutation: ({ docId, contextDocId }: { docId: string, contextDocId: string }) =>
      apiFetch('/api/docs/:docId/context/links', { method: 'post', path: { docId }, body: { contextDocId } }),
    onSuccess: () => invalidate(cache, projectContextKeys.root)
  })
}

export function useRemoveContextLink() {
  const cache = useQueryCache()
  return useMutation({
    mutation: ({ docId, contextDocId }: { docId: string, contextDocId: string }) =>
      apiFetch('/api/docs/:docId/context/links/:contextDocId', { method: 'delete', path: { docId, contextDocId } }),
    onSuccess: () => invalidate(cache, projectContextKeys.root)
  })
}
