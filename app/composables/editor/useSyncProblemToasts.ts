import type { SyncCloseReason } from '~~/shared/contracts/syncClose'

/**
 * One toast per sync problem; the editor's banners carry the explanation
 * and the reload action. A sync auth failure says read-only isn't a
 * permission problem but a sync-layer one (per-IP rate limit, a sync
 * container restarted with a different JWT secret, clock skew). A refused
 * update (too large / invalid document setting) stopped the provider:
 * later edits stay local. Returns the rejection's message for the banner.
 */
export function useSyncProblemToasts(syncAuthFailed: Readonly<Ref<boolean>>, syncRejection: Readonly<Ref<SyncCloseReason | null>>) {
  const { t } = useI18n()
  const toast = useToast()

  watch(syncAuthFailed, (failed) => {
    if (!failed) return
    toast.add({
      title: t('editor.syncAuthFailedTitle'),
      description: t('editor.syncAuthFailedDescription'),
      icon: 'i-lucide-shield-alert',
      color: 'error'
    })
  })

  const syncRejectionMessage = computed(() => {
    switch (syncRejection.value) {
      case 'update-too-large': return t('editor.syncRejected.updateTooLarge')
      case 'document-too-large': return t('editor.syncRejected.documentTooLarge')
      case 'invalid-meta': return t('editor.syncRejected.invalidMeta')
      case 'invalid-update': return t('editor.syncRejected.invalidUpdate')
      case null:
      default: return null
    }
  })
  watch(syncRejectionMessage, (message) => {
    if (!message) return
    toast.add({
      title: t('editor.syncRejected.title'),
      description: message,
      icon: 'i-lucide-cloud-off',
      color: 'error'
    })
  })

  return { syncRejectionMessage }
}
