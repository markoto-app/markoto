import type { TabName } from '~/components/editor/tabBarTypes'

/**
 * The open document's workspace, for the editor. Knowledge is
 * workspace-level: standalone / anonymous docs have none, and non-members
 * don't see the tab (`role` is non-null iff the viewer is a member). AI
 * availability and voice follow the document's workspace (a Team /
 * Business plan may unlock what the personal plan doesn't).
 */
export function useDocWorkspaceContext(
  workspaceId: Readonly<Ref<string | null>>,
  role: Readonly<Ref<string | null>>,
  rightSidebar: Ref<TabName | null>
) {
  const hasKnowledgeAccess = computed(() => Boolean(workspaceId.value) && role.value !== null)

  useClaimAiWorkspaceContext(() => (role.value !== null ? workspaceId.value : null))
  // Close the knowledge panel if the doc moves to a workspace the user isn't in
  // (or out of one), so no empty column is left.
  watch(hasKnowledgeAccess, (allowed) => {
    if (!allowed && rightSidebar.value === 'knowledge') rightSidebar.value = null
  })

  return { hasKnowledgeAccess }
}
