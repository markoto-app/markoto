import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { useDatabase } from '../utils/database'
import { signalMigrationsComplete } from '../utils/migrations'

// Apply Drizzle migrations at boot. Idempotent: drizzle-kit's migrator tracks
// applied migrations in `__drizzle_migrations` and only runs new ones.
//
// Migration files live in `./drizzle/` (relative to the process cwd), generated
// via `bun run db:generate`. The Dockerfile copies that folder into the runtime
// image so the same path resolves in production.
//
// Fires `signalMigrationsComplete()` on success so plugins that kick off
// DB-touching startup work can await it instead of racing us.
export default defineNitroPlugin(async () => {
  const migrationsFolder = process.env.DRIZZLE_MIGRATIONS_DIR || './drizzle'
  try {
    const db = useDatabase()
    await migrate(db, { migrationsFolder })
    console.log('[db-migrate] Migrations applied successfully.')
    signalMigrationsComplete()
  } catch (e: any) {
    console.error('[db-migrate] Migration failed:', e?.message || e)
    throw e
  }
})
