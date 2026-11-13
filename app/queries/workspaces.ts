// Workspaces as server state: the caller's workspace list
// (`/api/user/workspaces`: dashboard, "Move to workspace") and the
// mutations that change it or the caller's owned-workspace count.
//
// The workspace page's own detail (`/api/workspaces/:wsId`) stays with the
// page: it classifies 403 / 404 / SSO-required answers itself and patches
// the loaded copy in place after each panel's change.
import { defineQueryOptions, useMutation, useQuery, useQueryCache, type QueryCache } from '@pinia/colada'
import { apiFetch, type ApiCall, type ApiFetcher } from '~/utils/api/client'
import { billingKeys } from './billing'
import { invalidate } from './invalidate'

export const workspaceKeys = {
  root: ['workspaces'] as const,
  /** The workspaces the caller belongs to, with their role in each. */
  mine: () => [...workspaceKeys.root, 'mine'] as const
}

const myWorkspacesQuery = defineQueryOptions(({ api }: { api: ApiFetcher }) => ({
  key: workspaceKeys.mine(),
  query: ({ signal }) => api('/api/user/workspaces', { signal }),
  // Always re-read when a view mounts or the move dialog opens, as before:
  // each row carries a document count that every document create / move /
  // delete changes, and those are not routed through these mutations. The
  // cache still renders the last list at once instead of a spinner.
  staleTime: 0
}))

/**
 * Loaded after mount (the server render has no list: a cookie-less SSR
 * call would 401), and only while `active`, the move dialog stays mounted
 * while closed.
 */
export function useMyWorkspaces(active: MaybeRefOrGetter<boolean> = true) {
  const { loggedIn } = useUserSession()
  return useQuery(() => ({
    ...myWorkspacesQuery({ api: apiFetch }),
    enabled: import.meta.client && loggedIn.value && toValue(active)
  }))
}

/** Membership changed: the list (names, roles) is out of date. */
function membershipChanged(cache: QueryCache) {
  return invalidate(cache, workspaceKeys.root)
}

/** The caller now owns one more or one fewer workspace: the cap counter moved too. */
function ownershipChanged(cache: QueryCache) {
  return invalidate(cache, workspaceKeys.root, billingKeys.user())
}

type WorkspaceBody = NonNullable<ApiCall<'/api/workspaces', 'post'>['body']>
type WorkspaceUpdate = NonNullable<ApiCall<'/api/workspaces/:wsId', 'put'>['body']>

export function useCreateWorkspace() {
  const cache = useQueryCache()
  return useMutation({
    mutation: (body: WorkspaceBody) => apiFetch('/api/workspaces', { method: 'post', body }),
    // Not awaited: the caller navigates to the new workspace at once.
    onSuccess: () => { void ownershipChanged(cache) }
  })
}

export function useUpdateWorkspace() {
  const cache = useQueryCache()
  return useMutation({
    mutation: ({ workspaceId, body }: { workspaceId: string, body: WorkspaceUpdate }) =>
      apiFetch('/api/workspaces/:wsId', { method: 'put', path: { wsId: workspaceId }, body }),
    onSuccess: () => { void membershipChanged(cache) }
  })
}

export function useDeleteWorkspace() {
  const cache = useQueryCache()
  return useMutation({
    mutation: (workspaceId: string) => apiFetch('/api/workspaces/:wsId', { method: 'delete', path: { wsId: workspaceId } }),
    onSuccess: () => { void ownershipChanged(cache) }
  })
}

type MemberRole = 'admin' | 'editor' | 'viewer'

export function useChangeMemberRole() {
  const cache = useQueryCache()
  return useMutation({
    mutation: ({ workspaceId, userId, role }: { workspaceId: string, userId: number, role: MemberRole }) =>
      apiFetch('/api/workspaces/:wsId/members/:userId', { method: 'patch', path: { wsId: workspaceId, userId }, body: { role } }),
    // The caller's own role shows in their list.
    onSuccess: () => { void membershipChanged(cache) }
  })
}

/** Removing someone, or the caller leaving. */
export function useRemoveMember() {
  const cache = useQueryCache()
  return useMutation({
    mutation: ({ workspaceId, userId }: { workspaceId: string, userId: number }) =>
      apiFetch('/api/workspaces/:wsId/members/:userId', { method: 'delete', path: { wsId: workspaceId, userId } }),
    onSuccess: () => { void membershipChanged(cache) }
  })
}

export function useAcceptInvite() {
  const cache = useQueryCache()
  return useMutation({
    mutation: (inviteId: string) => apiFetch('/api/user/invites/:inviteId/accept', { method: 'post', path: { inviteId } }),
    onSuccess: () => membershipChanged(cache)
  })
}

/** The emailed link: accept or decline by token. */
export function useAnswerInviteByToken() {
  const cache = useQueryCache()
  return useMutation({
    mutation: (body: { token: string, action: 'accept' | 'decline' }) =>
      apiFetch('/api/user/invites/by-token', { method: 'post', body }),
    onSuccess: (_res, { action }) => { if (action === 'accept') void membershipChanged(cache) }
  })
}
