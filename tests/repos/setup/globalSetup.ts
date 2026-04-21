import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { waitForDb, closeTestDb } from '../../integration/setup/db'
import { TEST_DB_URL } from '../../integration/setup/env'

// Repo-test globalSetup. Runs once before any repo test file. The repos
// layer is plain TS — no Nuxt subprocess needed. We just:
//   1. Wait until the test Postgres is reachable (user must `docker
//      compose -f docker-compose.test.yml up -d` first).
//   2. Run migrations against it using drizzle-kit's in-code migrator —
//      same path the Nuxt app's `00-db-migrate` plugin takes, so the
//      schema matches prod exactly.
//   3. Set DATABASE_URL so every subsequent `useDatabase()` in the repos
//      under test binds to the same pool.
//
// Each test file imports `resetDb` from the integration harness and
// TRUNCATEs between cases for isolation — no need to re-migrate.

export default async function globalSetup() {
  console.log('[repos-test] waiting for test DB...')
  await waitForDb()

  // Migrate directly; avoids booting Nuxt just to run the plugin.
  process.env.DATABASE_URL = TEST_DB_URL
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  const db = drizzle(pool)
  console.log('[repos-test] running migrations...')
  await migrate(db, { migrationsFolder: './drizzle' })
  await pool.end()
  console.log('[repos-test] migrations applied. Running tests.')

  return async () => {
    await closeTestDb()
  }
}
