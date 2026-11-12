import { EnvError, loadEnv, primeEnv, runtimeEnv } from '../../shared/env/load'
import type { RawEnv } from '../../shared/env/define'
import type { SyncEnv } from '../../shared/env/registry'

// The sync server's configuration: the `sync` view of the env registry
// (shared/env/), validated once at boot by ./boot-env.ts.

/**
 * The typed env. After boot it is the validated one; a module imported on
 * its own (unit tests) gets a lenient parse, types checked, required
 * values '' when missing (see `runtimeEnv`).
 */
export function syncEnv(): SyncEnv {
  return runtimeEnv('sync')
}

/** Parse an env-shaped record the way the sync server would (tests). */
export function syncEnvFrom(source: RawEnv): SyncEnv {
  return loadEnv('sync', source, { relaxRequired: true, rules: false })
}

/** Validate the process env; on failure print every problem and exit 1. */
export function bootSyncEnv(): void {
  try {
    primeEnv('sync', loadEnv('sync'))
  } catch (e) {
    if (!(e instanceof EnvError)) throw e
    console.error(e.message)
    process.exit(1)
  }
}
