import type { Awareness } from 'y-protocols/awareness'

/**
 * Menu actions of the editor page that leave the document: a new document,
 * the docs, logging out.
 */
export function useEditorActions(awareness: Awareness) {
  const { t } = useI18n()
  const toast = useToast()

  // Anonymous visitors pass the same terms + bot-check gate as the new-document dialog (useAnonDocCreate).
  const anonDoc = useAnonDocCreate()
  async function newDocument() {
    try {
      const docId = await anonDoc.createDocument()
      void navigateTo(`/d/${docId}`)
    } catch (e) {
      if (e instanceof AnonGateCancelled) return
      toast.add({ title: t('error.documentCreateFailed'), color: 'error' })
    }
  }

  // Logout clears localStorage/sessionStorage/IDB, broadcasts to other tabs and
  // tears down awareness BEFORE the session goes, so collaborators see the
  // leaving frame on a still-open WS. See `composables/useLogout.ts`.
  const { logout: performAuthLogout } = useLogout()
  function handleLogout() {
    return performAuthLogout({
      beforeClear: () => {
        try {
          awareness.setLocalStateField('user', null)
        } catch { /* awareness may already be torn down */ }
      }
    })
  }

  // Help → Documentation opens in a new tab so the document stays open.
  function openDocs(): void {
    window.open('/docs', '_blank', 'noopener')
  }

  return { newDocument, handleLogout, openDocs }
}
