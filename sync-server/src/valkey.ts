import Redis from 'ioredis'
import { valkeyClientConfigFromEnv } from '../../shared/utils/connectionStrings'

// Singleton ioredis client for the sync-server. Mirrors the pattern in
// `server/utils/valkey.ts` (the Nuxt app's client) — the sync-server is
// its own Bun process, so it owns its own connection pool. Used to back
// per-doc attribution + diff-baseline state that used to live in
// process-local Maps; migrated so multiple sync-server instances can
// share the state instead of each holding a partial view.
//
// Operations against this client are best-effort — every call site MUST
// catch errors and fall through to the awareness heuristic. Losing
// Valkey should degrade attribution, not break sync.

let client: Redis | null = null

export function useValkey(): Redis {
  if (client) return client

  // TLS opt-in mirrors the app's client — see server/utils/valkey.ts and
  // docs/SECURITY-HARDENING.md.
  const { url, options: tlsOptions } = valkeyClientConfigFromEnv()
  client = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    ...tlsOptions
  })

  client.on('error', (e: Error) => {
    console.warn('[sync-valkey] client error:', e.message)
  })

  return client
}

export async function closeValkey(): Promise<void> {
  if (!client) return
  try {
    await client.quit()
  } finally {
    client = null
  }
}

// Test-only seam: lets unit tests inject a fake client matching ioredis's
// shape without touching the singleton state. Production code never calls
// this — the env-driven `useValkey()` is the only callsite.
export function _setValkeyClientForTests(fake: Redis | null): void {
  client = fake
}
