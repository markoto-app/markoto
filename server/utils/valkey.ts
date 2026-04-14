import Redis from 'ioredis'

// Singleton ioredis client for Valkey (Redis-compatible). Used today by
// rate-limiting; future consumers (cache, GlitchTip broker) share the same
// instance via key prefixes.
//
// Fails fast at boot if `VALKEY_URL` isn't set — every prod endpoint that
// matters calls `checkRateLimit`, so silently degrading to "no Valkey" is
// worse than refusing to start.

let client: Redis | null = null

export function useValkey(): Redis {
  if (client) return client

  const url = process.env.VALKEY_URL
  if (!url) {
    throw new Error('[valkey] VALKEY_URL environment variable is required')
  }

  client = new Redis(url, {
    // Let ioredis queue commands while the initial connection establishes —
    // avoids dropping the very first checkRateLimit after boot.
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true
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
