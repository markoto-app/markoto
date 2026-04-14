// Signal that unblocks DB-touching startup tasks once migrations are in.
//
// Nitro instantiates plugins without guaranteeing their async work finishes
// before the next plugin runs — specifically, a plugin that kicks off a
// fire-and-forget `void (async () => {...})()` IIFE will see its DB query
// race the migrator. Any plugin that needs a migrated schema at startup
// should `await migrationsComplete` before touching the DB.
//
// Module-scoped Promise: one instance per Nitro process. `00-db-migrate.ts`
// resolves it after successful migration; on failure the plugin throws and
// the process exits, so the promise stays pending forever — waiting plugins
// simply never run their startup work, which is what we want.

let resolveFn: () => void = () => {}

export const migrationsComplete: Promise<void> = new Promise<void>((resolve) => {
  resolveFn = resolve
})

export function signalMigrationsComplete(): void {
  resolveFn()
}
