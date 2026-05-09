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
  // `bun run build` boots Nitro in prerender mode (PWA workbox needs `/`
  // pre-rendered), which fires every plugin. We have no DB at build time —
  // skip. The plugin still runs at every real container start.
  if (import.meta.prerender) return

  const migrationsFolder = process.env.DRIZZLE_MIGRATIONS_DIR || './drizzle'
  try {
    const db = useDatabase()
    await migrate(db, { migrationsFolder })
    console.log('[db-migrate] Migrations applied successfully.')
    signalMigrationsComplete()
  } catch (e) {
    console.error('[db-migrate] Migration failed:', e instanceof Error ? e.message : e)
    throw e
  }
})
