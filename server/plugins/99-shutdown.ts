import { closeDatabase } from '../utils/database'
import { closeValkey } from '../utils/valkey'

// Closes long-lived network handles when Nitro shuts down. Numeric `99-`
// prefix forces this to load LAST so other plugins are still set up when
// their `close` hooks run, and so we tear down after them.
//
// Nitro itself handles HTTP listener shutdown; we just need to release the
// pg pool and the Valkey client so in-flight work can drain instead of
// being killed mid-request.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('close', async () => {
    console.log('[shutdown] Closing database pool…')
    try {
      await closeDatabase()
      console.log('[shutdown] Database pool closed.')
    } catch (e: any) {
      console.warn('[shutdown] Database pool close failed:', e?.message || e)
    }

    console.log('[shutdown] Closing Valkey client…')
    try {
      await closeValkey()
      console.log('[shutdown] Valkey client closed.')
    } catch (e: any) {
      console.warn('[shutdown] Valkey client close failed:', e?.message || e)
    }
  })
})
