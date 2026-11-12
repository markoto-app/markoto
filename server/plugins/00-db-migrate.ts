import { applyMigrations as runMigrations } from '../repos/connection'
import { signalMigrationsComplete } from '../utils/platform/migrations'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../utils/platform/logger'

const log = useLogger('db-migrate')

// Apply Drizzle migrations at boot. Idempotent: drizzle-kit's migrator tracks
// applied migrations in `__drizzle_migrations` and only runs new ones.
//
// Migration files live in `./drizzle/` (relative to the process cwd), generated
// via `bun run db:generate`. The Dockerfile copies that folder into the runtime
// image so the same path resolves in production.
//
// Fires `signalMigrationsComplete()` on success so plugins that kick off
// DB-touching startup work can await it instead of racing us.
export default defineNitroPlugin(() => {
  // `bun run build` boots Nitro in prerender mode (PWA workbox needs `/`
  // pre-rendered), which fires every plugin. We have no DB at build time —
  // skip. The plugin still runs at every real container start.
  if (import.meta.prerender) return

  // Nitro doesn't await plugins; startup work that needs the schema awaits
  // `migrationsComplete` instead. A failed migration stops the process: the
  // app must not serve requests against a schema it doesn't match.
  applyMigrations().catch((e: unknown) => {
    log.error('Migration failed', { err: e })
    process.exit(1)
  })
})

async function applyMigrations(): Promise<void> {
  await runMigrations(useEnv().server.migrationsDir)
  log.info('Migrations applied successfully.')
  signalMigrationsComplete()
}
