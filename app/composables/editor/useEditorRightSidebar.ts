import type { TabName } from '~/components/editor/tabBarTypes'

/**
 * The editor's right-sidebar slot: one panel at a time (document, comments,
 * suggestions, activity, theme, references, knowledge, and on a phone the
 * "editor" commands drawer and the "navigator" sheet), so the layout shift
 * is predictable. Escape closes the open panel, except while a modal-like
 * layer is up: Nuxt UI modals own Escape in their stack, and it must not
 * also reach the sidebar after dismissing the modal.
 */
export function useEditorRightSidebar(anyModalOpen: Readonly<Ref<boolean>>) {
  const rightSidebar = ref<TabName | null>(null)
  function toggleSidebar(panel: TabName) {
    rightSidebar.value = rightSidebar.value === panel ? null : panel
  }
  function closeSidebar() {
    rightSidebar.value = null
  }
  onKeyStroke('Escape', () => {
    if (anyModalOpen.value) return
    if (rightSidebar.value) closeSidebar()
  })
  return { rightSidebar, toggleSidebar, closeSidebar }
}
