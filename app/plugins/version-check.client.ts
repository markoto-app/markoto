// Two update signals, one toast.
//
// 1. `$pwa.needRefresh`: set by the service worker when a new precache is
//    ready (PWA-installed clients).
// 2. `/api/version` poll: covers tabs without a SW (and dev, where the SW is
//    disabled). A different `buildId` means the SPA shell is older than the
//    server. In dev the id never changes, so the poll is a no-op.
//
// On mismatch a sticky toast shows and a 30s auto-reload starts, with two
// escapes: "Reload now" and "Snooze 5 min" (defers the auto-reload; the
// next poll re-evaluates).
//
// The reload is unconditional, with no "mid-edit" suppression: Y.Doc and AI
// session state live inside the editor's orchestrator, and a global
// "is mid-edit" signal would force every editor surface to publish into a
// shared store. A visible countdown plus the 30s window (Hocuspocus flushes
// within ~2s) makes losing an in-flight change very unlikely.
//
// State-machine logic is in `app/utils/platform/versionCheckController.ts`
// (unit-testable without Nuxt); this plugin is the glue (toast + $fetch + $pwa).

// @vite-pwa/nuxt augments NuxtApp with `$pwa`, but the augmentation isn't
// visible under `.nuxt/tsconfig.server.json`, so the shape is re-asserted via
// the module's own `PwaInjection` interface; a module change then gives a
// type error here instead of a silent runtime miss.
import type { UnwrapNestedRefs } from 'vue'
import type { PwaInjection } from '@vite-pwa/nuxt/dist/runtime/plugins/types.js'
import {
  createVersionCheckController,
  type VersionCheckPromptHandlers
} from '../utils/platform/versionCheckController'
import { MINUTE_MS } from '~~/shared/config/units'

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

  // Fetch failures become `null` (= skip this round): `$fetch` rejections are
  // normal during transient outages.
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

  // First probe when idle: interval-only would leave a 5-minute blind spot at
  // startup, but it needn't compete with the page's own first requests.
  const firstPoll = (): void => {
    void controller.poll()
  }
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(firstPoll, { timeout: 5000 })
  } else {
    setTimeout(firstPoll, 2000)
  }

  // The controller doesn't know about $pwa, so this path drives the same
  // prompt renderer directly.
  let pwaPromptShown = false
  if (pwa) {
    watch(() => pwa.needRefresh, (needs) => {
      if (!needs || pwaPromptShown) return
      pwaPromptShown = true
      // Must go through `updateServiceWorker` so the next navigation loads the new precache.
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
          }, 5 * MINUTE_MS)
        }
      })
      // One prompt is enough.
      controller.dispose()
    }, { immediate: true })
  }

  // Re-check when the window regains focus (a user returning to a long-open
  // tab). `useWindowFocus` owns the listener and its cleanup.
  const focused = useWindowFocus()
  watch(focused, (v) => {
    if (v) controller.onVisible()
  })

  // `useWindowFocus` tracks focus/blur, which a tab in a background window may
  // never receive; `visibilitychange` fires reliably on tab switches.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') controller.onVisible()
    })
  }
})
