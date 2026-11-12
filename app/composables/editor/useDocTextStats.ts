import type * as Y from 'yjs'

/**
 * The document text as a reactive string (for the preview) and its word /
 * character counts. The word count and size are persisted for the owner,
 * debounced to 10 s after the last change, so document lists can show them.
 */
export function useDocTextStats(opts: {
  docId: string
  ydoc: Y.Doc
  ytext: Y.Text
  synced: Readonly<Ref<boolean>>
  isOwner: Readonly<Ref<boolean>>
  requiresPassword: Readonly<Ref<boolean>>
}) {
  // Observes the Y.Doc 'update' event rather than ytext.observe: yCollab
  // replaces the text binding in EditorPane's onMounted, while the
  // doc-level event fires for every mutation.
  const textContent = shallowRef('')
  const updateContent = () => {
    textContent.value = opts.ytext.toString()
  }
  opts.ydoc.on('update', updateContent)
  // Also update when sync completes (initial server content doesn't always fire 'update').
  watch(opts.synced, (isSynced) => {
    if (isSynced) updateContent()
  })
  const persistStats = useDebounceFn(() => {
    if (!opts.isOwner.value || opts.requiresPassword.value || !textContent.value) return
    apiFetch('/api/docs/:docId/meta', {
      method: 'put',
      path: { docId: opts.docId },
      body: {
        wordCount: wordCount.value,
        sizeBytes: new Blob([textContent.value]).size
      }
    }).catch(() => {})
  }, 10000)

  watch(textContent, () => {
    void persistStats()
  })
  // Also persist once the initial sync completes.
  watch(opts.synced, (s) => {
    if (s) void persistStats()
  })

  onUnmounted(() => {
    opts.ydoc.off('update', updateContent)
  })

  const wordCount = computed(() => {
    if (!textContent.value.trim()) return 0
    return textContent.value.trim().split(/\s+/).length
  })
  const charCount = computed(() => textContent.value.length)

  return { textContent, wordCount, charCount }
}
