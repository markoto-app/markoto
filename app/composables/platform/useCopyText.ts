/**
 * Clipboard copy for click handlers. VueUse's `copy` rejects when the browser
 * refuses (permission denied, document not focused, insecure context), and a
 * click handler has nobody to catch that: the user would press "Copy" and see
 * nothing. Failures become a toast instead; `copied` flips for the "Copied"
 * state of the button.
 */
export function useCopyText() {
  const { t } = useI18n()
  const toast = useToast()
  const { copy: copyRaw, copied } = useClipboard()

  function copy(text: string): void {
    copyRaw(text).catch(() => {
      toast.add({ title: t('common.copyFailed'), icon: 'i-lucide-alert-circle', color: 'error' })
    })
  }

  return { copy, copied }
}
