import { closeTestDb, waitForDb } from './db'
import { startNuxt, stopNuxt } from './server'

// vitest globalSetup: runs once for the whole integration test run in a
// separate process from the test worker.
//
// Sequence:
//   1. Verify the test Postgres is reachable (user must `docker compose
//      -f docker-compose.test.yml up -d` before running tests).
//   2. Boot the Nuxt dev subprocess with TEST_MODE=1 and point its env
//      at the test DB + stub sync-server.
//   3. Nuxt runs migrations on boot (server/plugins/00-db-migrate.ts),
//      so when Nuxt reports healthy the schema is ready.
//
// The sync-server stub is NOT started here — it's started from a
// setupFile (stubSetup.ts) inside the test worker so the in-memory
// `calls` array shares a process with the test assertions. Nuxt still
// talks to it over HTTP: the port is fixed.
//
// Teardown runs on success OR failure (vitest guarantees this).

export default async function globalSetup() {
  console.log('[integration] waiting for test DB...')
  await waitForDb()

  console.log('[integration] booting Nuxt subprocess (this may take ~15s)...')
  await startNuxt()
  console.log('[integration] Nuxt ready. Running tests.')

  return async () => {
    console.log('[integration] tearing down...')
    await stopNuxt()
    await closeTestDb()
  }
}
