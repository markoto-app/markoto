// Two update signals, one toast.
//
// 1. `$pwa.needRefresh` — set by the service worker when a new precache is
//    ready. Fires on PWA-installed clients; primary path for users who
//    added markoto to home screen.
// 2. `/api/version` poll — covers the non-PWA path (tabs without a SW, or
//    dev where the SW is disabled). Mismatched `buildId` means the SPA
//    shell is older than the server.
//
// On mismatch we show a sticky toast AND start a 30s grace-period auto-
// reload. The user gets two manual escapes:
//   - "Reload now" — reload immediately.
//   - "Snooze 5 min" — defer the auto-reload by 5 minutes. The version
//     mismatch isn't suppressed; if the build id keeps changing during
//     the snooze, the next poll re-evaluates.
//
// Why unconditional auto-reload (no "mid-edit" suppression)?
// The Y.Doc sync state and AI session state aren't trivially exposed at
// plugin scope — they live inside the editor page's document
// orchestrator. Wiring a global "is mid-edit" signal would force every
// editor surface to publish into a shared store; for a tool that's
// fundamentally about *not* losing user content, the simpler design
// wins: explicit reload countdown the user can see, two clearly-labeled
// escape hatches, no silent reload mid-keystroke. The 30s window plus
// Hocuspocus's normal flush cadence (≤2s) means an in-flight Y.js
// change is overwhelmingly likely to be persisted before reload.
//
// We also poll on `visibilitychange` — a tab returning from background
// detects the mismatch immediately rather than waiting up to 5min.
//
// In dev (`buildId === 'dev'`) the poll is effectively a no-op — dev keeps
// the same id across requests, so no mismatch is possible.
//
// All state-machine logic lives in `app/utils/versionCheckController.ts`
// so it's unit-testable without booting Nuxt; this plugin is just the
// glue (toast + $fetch + $pwa).

// @vite-pwa/nuxt augments NuxtApp with `$pwa`, but that augmentation isn't
// visible under `.nuxt/tsconfig.server.json`, so we re-assert the shape
// using the module's own canonical `PwaInjection` interface. If the module
// reshapes its exports (rename, move, drop a field we use) we get a clear
// type error here instead of a silent runtime miss.
import type { UnwrapNestedRefs } from 'vue'
import type { PwaInjection } from '@vite-pwa/nuxt/dist/runtime/plugins/types.js'
import {
  createVersionCheckController,
  type VersionCheckPromptHandlers
} from '../utils/versionCheckController'

type Pwa = UnwrapNestedRefs<PwaInjection>

function reloadNow() {
  globalThis.location.reload()
}

export default defineNuxtPlugin((nuxtApp) => {
  const toast = useToast()
  const pwa = nuxtApp.$pwa as Pwa | undefined

  function renderPrompt(h: VersionCheckPromptHandlers) {
    toast.add({
      title: 'New version available',
      description: 'Reloading in 30 seconds.',
      icon: 'i-lucide-refresh-cw',
      color: 'primary',
      duration: 0,
      actions: [
        { label: 'Reload now', onClick: h.onReloadNow },
        {
          label: 'Snooze 5 min',
          color: 'neutral',
          variant: 'subtle',
          onClick: h.onSnooze
        }
      ]
    })
  }

  // Polling controller. Wraps fetch failures so the controller's
  // typed deps see `null` (= "skip this round") rather than a thrown
  // error — `$fetch` rejections are normal during transient outages.
  const controller = createVersionCheckController({
    fetchBuildId: async () => {
      try {
        const res = await $fetch<{ buildId: string }>('/api/version')
        return res?.buildId ?? null
      } catch {
        return null
      }
    },
    reload: reloadNow,
    showPrompt: renderPrompt
  })

  // First probe once the page is idle — interval-only would mean a
  // 5-minute blind spot at startup, but the probe doesn't need to compete
  // with the page's own first requests either (a fresh page load is the
  // current build anyway, unless the deploy lands in these seconds).
  const firstPoll = (): void => {
    void controller.poll()
  }
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(firstPoll, { timeout: 5000 })
  } else {
    setTimeout(firstPoll, 2000)
  }

  // SW-driven path: watch $pwa.needRefresh. The controller doesn't know
  // about $pwa, so when the SW signals a new precache we drive the
  // prompt + reload action directly via the same renderer.
  let pwaPromptShown = false
  if (pwa) {
    watch(() => pwa.needRefresh, (needs) => {
      if (!needs || pwaPromptShown) return
      pwaPromptShown = true
      // For the SW path the reload must go through `updateServiceWorker`
      // so the next navigation loads the new precache.
      const swReload = () => pwa.updateServiceWorker(true)
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        timer = null
        swReload()
      }, 30 * 1000)
      renderPrompt({
        onReloadNow: () => {
          if (timer) {
            clearTimeout(timer)
            timer = null
          }
          swReload()
        },
        onSnooze: () => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            timer = null
            swReload()
          }, 5 * 60 * 1000)
        }
      })
      // Either path's toast invalidates the polling controller — no
      // need for two simultaneous prompts.
      controller.dispose()
    }, { immediate: true })
  }

  // Re-check whenever the window regains focus — catches the common
  // case of a user coming back to a long-open tab. `useWindowFocus`
  // owns the listener + cleanup; previous code added a raw listener
  // that never got removed (plugins outlive normal Vue scopes, but
  // tying this through the composable still does the right thing in
  // dev/HMR).
  const focused = useWindowFocus()
  watch(focused, (v) => {
    if (v) controller.onVisible()
  })

  // Also listen for `visibilitychange` directly — `useWindowFocus`
  // tracks `focus`/`blur`, which a tab in a background window may
  // never receive even when it becomes hidden. `visibilitychange`
  // fires reliably on tab-switch and on returning to a background
  // tab, which is the exact case we want to catch (a stale tab
  // surfaced after the user leaves it idle for hours).
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') controller.onVisible()
    })
  }
})
