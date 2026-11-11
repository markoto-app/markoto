// The new-document dialog, mounted on first use.
//
// `DocumentNewDocumentDialog` pulls in Nuxt UI's Select / InputMenu /
// Modal and, once mounted, links every theme font's stylesheet for its
// preset cards — far too much for a page whose visitor may never click
// "Start writing" (the product page, the marketing pages). Callers render
// `<LazyDocumentNewDocumentDialog v-if="mounted" v-model:open="open">`:
// nothing of it loads until `show()`. `warm()` (pointer over / focus on the
// button) fetches the chunk a moment early, so the dialog opens without a
// visible wait: pass `() => import('~/components/document/NewDocumentDialog.vue')`
// (the same module as the Lazy component, so the same chunk; the import
// lives in the calling SFC, where `.vue` modules resolve for the type
// checker). Once mounted it stays mounted, so closing animates.
export function useNewDocDialog(load: () => Promise<unknown>) {
  const mounted = ref(false)
  const open = ref(false)

  function warm(): void {
    load().catch(() => {
      // Offline / deploy skew: show() tries again and reports through Nuxt.
    })
  }

  function show(): void {
    mounted.value = true
    open.value = true
  }

  return { mounted, open, show, warm }
}
