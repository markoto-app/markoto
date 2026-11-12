/**
 * Edit / split / preview. Read-only viewers see the preview; edit access
 * coming back (a password unlock) switches to split. Below the mobile
 * breakpoint split is not offered: it falls back to edit.
 */
export function useEditorViewMode(isReadOnly: Readonly<Ref<boolean>>) {
  const viewMode = ref<'edit' | 'preview' | 'split'>('split')
  // Matches Tailwind's sm: breakpoint (640px and up is not mobile)
  const isMobile = useMediaQuery('(max-width: 639px)')

  watch(isReadOnly, (readOnly) => {
    if (readOnly) {
      viewMode.value = 'preview'
    } else if (viewMode.value === 'preview') {
      // Edit access restored (e.g. after password verification): switch to split
      viewMode.value = isMobile.value ? 'edit' : 'split'
    }
  }, { immediate: true })

  watchEffect(() => {
    if (isMobile.value && viewMode.value === 'split') {
      viewMode.value = 'edit'
    }
  })

  return { viewMode, isMobile }
}
