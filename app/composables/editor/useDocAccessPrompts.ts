/**
 * What the editor shows when access to the open document changes: the
 * password prompt (open while `requiresPassword` holds; closable only via
 * verify / cancel), and — when someone else deleted the document (e.g. the
 * owner elsewhere) — a toast and the way home. A deletion started here is
 * handled by the delete modal (own toast + redirect), so the deleter never
 * sees "deleted by the owner".
 */
export function useDocAccessPrompts(requiresPassword: Readonly<Ref<boolean>>, deletedByOther: Readonly<Ref<boolean>>) {
  const { t } = useI18n()
  const toast = useToast()

  const passwordModalOpen = ref(false)
  watch(requiresPassword, (val) => {
    passwordModalOpen.value = val
  }, { immediate: true })

  watch(deletedByOther, (deleted) => {
    if (!deleted) return
    toast.add({
      title: t('delete.remoteTitle'),
      description: t('delete.remoteDesc'),
      icon: 'i-lucide-trash-2',
      color: 'warning'
    })
    void navigateTo('/')
  })

  return { passwordModalOpen }
}
