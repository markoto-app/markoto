// Clicks before hydration are kept, not lost (app/utils/platform/earlyClicks.ts).
//
// Server: puts the small queueing script in the page head (the CSP plugin
// stamps its nonce like on Nuxt's own inline scripts). Client: once the app
// has hydrated, sets `<html data-hydrated>` and replays the queued clicks.

import { EARLY_CLICK_SCRIPT, markHydratedAndReplay } from '../utils/platform/earlyClicks'

export default defineNuxtPlugin((nuxtApp) => {
  if (import.meta.server) {
    useHead({ script: [{ key: 'mk-early-clicks', innerHTML: EARLY_CLICK_SCRIPT, tagPosition: 'head' }] })
    return
  }
  nuxtApp.hooks.hookOnce('app:suspense:resolve', () => {
    markHydratedAndReplay(document, window)
  })
})
