import Redis from 'ioredis'
import { valkeyClientConfigFromEnv } from '../../shared/utils/connectionStrings'

// Singleton ioredis client for Valkey (Redis-compatible). Used today by
// rate-limiting and session locks; future consumers share the same
// instance via key prefixes.
//
// Fails fast at boot if VALKEY_HOST/PORT aren't set — every prod endpoint
// that matters calls `checkRateLimit`, so silently degrading to "no
// Valkey" is worse than refusing to start.

let client: Redis | null = null

export function useValkey(): Redis {
  if (client) return client

  // TLS is opt-in via VALKEY_TLS_ENABLED. The helper returns
  // `options: undefined` when TLS is off, so the spread is a no-op for the
  // single-VPS case where the docker network IS the trust boundary. See
  // docs/SECURITY-HARDENING.md for the threat-model rationale.
  const { url, options: tlsOptions } = valkeyClientConfigFromEnv()
  client = new Redis(url, {
    // Let ioredis queue commands while the initial connection establishes —
    // avoids dropping the very first checkRateLimit after boot.
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    ...tlsOptions
  })

  // One subscriber per error — ioredis reconnects automatically, so these
  // logs are a signal for operators, not an app concern. checkRateLimit
  // fails open on the callsite catch.
  client.on('error', (e: Error) => {
    console.warn('[valkey] client error:', e.message)
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
