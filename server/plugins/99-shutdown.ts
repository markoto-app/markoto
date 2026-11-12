import { closeDatabaseConnections } from '../repos/connection'
import { closeValkey } from '../utils/platform/valkey'
import { useLogger } from '../utils/platform/logger'

const log = useLogger('shutdown')

// Closes long-lived network handles when Nitro shuts down. Numeric `99-`
// prefix forces this to load LAST so other plugins are still set up when
// their `close` hooks run, and so we tear down after them.
//
// Nitro itself handles HTTP listener shutdown; we just need to release the
// pg pool and the Valkey client so in-flight work can drain instead of
// being killed mid-request.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('close', async () => {
    log.info('Closing database pools…')
    try {
      await closeDatabaseConnections()
      log.info('Database pools closed.')
    } catch (e) {
      log.warn('Database pool close failed', { err: e })
    }

    log.info('Closing Valkey client…')
    try {
      await closeValkey()
      log.info('Valkey client closed.')
    } catch (e) {
      log.warn('Valkey client close failed', { err: e })
    }
  })
})
