// Unblocks DB-touching startup tasks once migrations are applied.
//
// Nitro does not wait for one plugin's async work before running the next, so
// a fire-and-forget startup query would race the migrator. Plugins that need
// the migrated schema `await migrationsComplete` first.
//
// `00-db-migrate.ts` resolves it. If migration fails the process exits and the
// promise stays pending, so waiting plugins never run their startup work.

let resolveFn: () => void = () => {}

export const migrationsComplete: Promise<void> = new Promise<void>((resolve) => {
  resolveFn = resolve
})

export function signalMigrationsComplete(): void {
  resolveFn()
}
