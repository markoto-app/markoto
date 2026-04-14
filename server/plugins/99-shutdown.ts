import { closeDatabase } from '../utils/database'

// Closes the pg pool when Nitro shuts down (SIGTERM / process exit). Numeric
// `99-` prefix forces this to load LAST so other plugins are still set up
// when their `close` hooks run, and so we run after them on teardown.
//
// Nitro itself handles HTTP listener shutdown; we just need to release the
// long-lived DB pool so pending queries can drain instead of being killed.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('close', async () => {
    console.log('[shutdown] Closing database pool…')
    try {
      await closeDatabase()
      console.log('[shutdown] Database pool closed.')
    } catch (e: any) {
      console.warn('[shutdown] Database pool close failed:', e?.message || e)
    }
  })
})
