import { browserHasCreatedDoc } from '~/utils/documents/firstDocument'

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
function useNewDocDialog(load: () => Promise<unknown>) {
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

/**
 * "Start writing" on the public pages: a first-time anonymous visitor gets
 * the Demo document at once (`QuickStartDocument.vue`, after the terms +
 * bot check); everyone else, and a caller that pre-selects a template,
 * gets the new-document dialog. Render
 * `<LazyDocumentQuickStartDocument v-if="quickMounted" :run="quickRun" @created @done="quickDone">`
 * next to the dialog.
 */
export function useStartWriting(load: () => Promise<unknown>) {
  const dialog = useNewDocDialog(load)
  const { loggedIn } = useUserSession()
  const quickMounted = ref(false)
  const quickRun = ref(0)
  const quickBusy = ref(false)

  function start(opts: { dialog?: boolean } = {}): void {
    if (!opts.dialog && !loggedIn.value && !browserHasCreatedDoc()) {
      if (quickBusy.value) return
      quickBusy.value = true
      quickMounted.value = true
      quickRun.value++
      return
    }
    dialog.show()
  }

  function quickDone(): void {
    quickBusy.value = false
  }

  return { ...dialog, start, quickMounted, quickRun, quickBusy, quickDone }
}
