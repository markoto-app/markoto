import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { waitForDb, closeTestDb } from '../../integration/setup/db'
import { TEST_DB_URL } from '../../integration/setup/env'
import { applyTestEnv } from '../../integration/setup/testEnv'

// Repo-test globalSetup. Runs once before any repo test file. The repos
// layer is plain TS — no Nuxt subprocess needed. We just:
//   1. Wait until the test Postgres is reachable (user must `docker
//      compose -f docker-compose.test.yml up -d` first).
//   2. Run migrations against it using drizzle-kit's in-code migrator —
//      same path the Nuxt app's `00-db-migrate` plugin takes, so the
//      schema matches prod exactly.
//   3. Set the canonical test env (DATABASE_URL + POSTGRES_*  + secrets)
//      via `applyTestEnv`, so every subsequent `useDatabase()` /
//      `useValkey()` call in the repos under test binds to the test
//      stack. See `tests/integration/setup/testEnv.ts` for the list.
//   4. Smoke-probe `useDatabase()` AFTER migrations to surface any
//      env-wiring regressions BEFORE 169 tests pile up FK violations.
//
// Each test file imports `resetDb` from the integration harness and
// TRUNCATEs between cases for isolation — no need to re-migrate.

export default async function globalSetup() {
  console.log('[repos-test] waiting for test DB...')
  await waitForDb()

  // Apply the canonical test env atomically — this owns DATABASE_URL +
  // POSTGRES_* atomic vars + VALKEY_* + test secrets. Must run BEFORE
  // any module reads connection strings (the migrate pool below or any
  // repo import).
  applyTestEnv()

  // Migrate directly; avoids booting Nuxt just to run the plugin.
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  const db = drizzle(pool)
  console.log('[repos-test] running migrations...')
  await migrate(db, { migrationsFolder: './drizzle' })
  await pool.end()
  console.log('[repos-test] migrations applied.')

  // Smoke-probe `useDatabase()` so any env-wiring regression that
  // would silently route the repos to a different DB / unreachable
  // pool fails HERE with a clear message, instead of producing FK
  // violations 100 assertions deep. The repos under test will go
  // through this exact pool — if SELECT 1 doesn't work here, NONE
  // of the tests that follow will work either.
  const { useDatabasePool, closeDatabase } = await import('../../../server/utils/platform/database')
  try {
    const probePool = useDatabasePool()
    const r = await probePool.query<{ one: number }>('SELECT 1 AS one')
    if (r.rows[0]?.one !== 1) {
      throw new Error(`SELECT 1 returned unexpected row: ${JSON.stringify(r.rows[0])}`)
    }
  } catch (e) {
    throw new Error(
      `[repos-test] useDatabase() smoke probe failed — env wiring is broken.\n`
      + `Did testEnv.applyTestEnv() set every var that postgresUrlFromEnv reads?\n`
      + `Original error: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    )
  }
  // Close the probe pool so the first real test gets a fresh one.
  // Without this the singleton would hold a connection across tests
  // that the closeTestDb() teardown wouldn't know about.
  await closeDatabase()
  console.log('[repos-test] smoke probe passed. Running tests.')

  return async () => {
    await closeTestDb()
  }
}
