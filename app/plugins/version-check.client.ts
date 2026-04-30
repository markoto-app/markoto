// Two update signals, one toast.
//
// 1. `$pwa.needRefresh` — set by the service worker when a new precache is
//    ready. Fires on PWA-installed clients; primary path for users who
//    added YPad to home screen.
// 2. `/api/version` poll — covers the non-PWA path (tabs without a SW, or
//    dev where the SW is disabled). Mismatched `buildId` means the SPA
//    shell is older than the server.
//
// We deliberately don't auto-reload: the user might be mid-edit. A sticky
// toast with a manual action is the right balance. Whichever signal lands
// first wins; we stop polling after showing the prompt to avoid duplicates.
//
// In dev (`buildId === 'dev'`) the poll is effectively a no-op — dev keeps
// the same id across requests, so no mismatch is possible.

// @vite-pwa/nuxt augments NuxtApp with `$pwa`, but that augmentation isn't
// visible under `.nuxt/tsconfig.server.json`, so we re-assert the shape
// using the module's own canonical `PwaInjection` interface. If the module
// reshapes its exports (rename, move, drop a field we use) we get a clear
// type error here instead of a silent runtime miss.
import type { UnwrapNestedRefs } from 'vue'
import type { PwaInjection } from '@vite-pwa/nuxt/dist/runtime/plugins/types.js'

const POLL_INTERVAL_MS = 5 * 60 * 1000

type Pwa = UnwrapNestedRefs<PwaInjection>

export default defineNuxtPlugin((nuxtApp) => {
  const toast = useToast()
  // `$pwa` is absent when the module is disabled (dev with
  // devOptions.enabled: false) — hence the optional.
  const pwa = nuxtApp.$pwa as Pwa | undefined
  let baseline: string | null = null
  let shown = false
  let interval: ReturnType<typeof setInterval> | null = null

  function promptReload(action: () => void) {
    if (shown) return
    shown = true
    if (interval) {
      clearInterval(interval)
      interval = null
    }

    toast.add({
      title: 'New version available',
      description: 'Reload to get the latest update.',
      icon: 'i-lucide-refresh-cw',
      color: 'primary',
      duration: 0,
      actions: [{
        label: 'Reload',
        onClick: action
      }]
    })
  }

  // SW-driven path: watch $pwa.needRefresh and delegate the reload to the
  // SW so the next navigation loads the new precache. `UnwrapNestedRefs`
  // means `.needRefresh` is a plain boolean here (not a Ref), so we pass
  // the field directly — Vue's watcher tracks the reactive source for us.
  if (pwa) {
    watch(() => pwa.needRefresh, (needs) => {
      if (needs) promptReload(() => pwa.updateServiceWorker(true))
    }, { immediate: true })
  }

  // Polling path: server-id mismatch.
  async function checkBuildId() {
    if (shown) return
    let buildId: string | null = null
    try {
      const res = await $fetch<{ buildId: string }>('/api/version')
      buildId = res?.buildId ?? null
    } catch {
      return
    }
    if (!buildId) return
    if (baseline === null) {
      baseline = buildId
      return
    }
    if (buildId === baseline) return
    promptReload(() => window.location.reload())
  }

  checkBuildId()
  interval = setInterval(checkBuildId, POLL_INTERVAL_MS)
  // Re-check whenever the window regains focus — catches the common
  // case of a user coming back to a long-open tab. `useWindowFocus`
  // owns the listener + cleanup; previous code added a raw listener
  // that never got removed (plugins outlive normal Vue scopes, but
  // tying this through the composable still does the right thing in
  // dev/HMR).
  const focused = useWindowFocus()
  watch(focused, (v) => {
    if (v) checkBuildId()
  })
})
