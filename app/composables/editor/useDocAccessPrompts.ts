/**
 * What the editor shows when access to the open document changes: the
 * password prompt (open while `requiresPassword` holds; closable only via
 * verify / cancel), and, when someone else deleted the document (its owner,
 * a workspace admin, a folder delete, a bulk delete): a notice that keeps
 * the text on screen and offers a Markdown copy before leaving. A deletion
 * started here is handled by the delete modal (own toast + redirect), so the
 * deleter never sees the notice.
 */
export function useDocAccessPrompts(requiresPassword: Readonly<Ref<boolean>>, deletedByOther: Readonly<Ref<boolean>>) {
  const passwordModalOpen = ref(false)
  watch(requiresPassword, (val) => {
    passwordModalOpen.value = val
  }, { immediate: true })

  // Open once when the deletion arrives; the person may close it to keep
  // reading (the text stays in the editor until they leave).
  const deletedNoticeOpen = ref(false)
  watch(deletedByOther, (deleted) => {
    if (deleted) deletedNoticeOpen.value = true
  })

  return { passwordModalOpen, deletedNoticeOpen }
}
