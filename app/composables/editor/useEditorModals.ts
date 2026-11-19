/**
 * The editor's document dialogs: share, delete (File → Delete, also from
 * Sharing), duplicate and move (File menu; the server re-checks authz, so
 * the menu's canManage gate is UX-only) and import. "Share..." in the
 * documents explorer opens the editor with `?share=1`, which opens the share
 * dialog. `anyOpen` tells the layout's Escape handler to leave the sidebar
 * alone while one of them owns Escape.
 */
export function useEditorModals() {
  const showShareModal = ref(false)
  const showDeleteModal = ref(false)
  const showDuplicateModal = ref(false)
  const showMoveModal = ref(false)
  const showImportModal = ref(false)

  const route = useRoute()
  onMounted(() => {
    if (route.query.share === '1') showShareModal.value = true
  })

  const anyOpen = computed(() => showShareModal.value || showDeleteModal.value || showDuplicateModal.value || showMoveModal.value || showImportModal.value)

  return { showShareModal, showDeleteModal, showDuplicateModal, showMoveModal, showImportModal, anyOpen }
}
