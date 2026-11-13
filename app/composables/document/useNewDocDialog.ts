// The new-document dialog, mounted on first use.
//
// `DocumentNewDocumentDialog` pulls in Nuxt UI's Select / InputMenu / Modal
// and, once mounted, links every theme font's stylesheet for its preset
// cards: too heavy for pages whose visitor may never click "Start writing".
// Callers render `<LazyDocumentNewDocumentDialog v-if="mounted" v-model:open="open">`,
// so nothing loads until `show()`. `warm()` (pointer over / focus on the
// button) fetches the chunk early; pass
// `() => import('~/components/document/NewDocumentDialog.vue')` (same chunk
// as the Lazy component; the import lives in the calling SFC because `.vue`
// modules only resolve for the type checker there). Once mounted it stays
// mounted so closing animates.
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
