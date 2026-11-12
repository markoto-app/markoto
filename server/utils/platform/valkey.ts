import Redis from 'ioredis'
import { valkeyClientConfigFromEnv } from '../../../shared/utils/runtime/connectionStrings'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from './logger'

const log = useLogger('valkey')

// Singleton ioredis client for Valkey (Redis-compatible), shared by all
// consumers via key prefixes.
//
// Fails fast when VALKEY_HOST/PORT aren't set: silently running without
// Valkey would disable rate limiting.

let client: Redis | null = null

export function useValkey(): Redis {
  if (client) return client

  // TLS is opt-in via VALKEY_TLS_ENABLED (`options` is undefined when off).
  // See docs/SECURITY-HARDENING.md.
  const { url, options: tlsOptions } = valkeyClientConfigFromEnv(useEnv().valkey)
  client = new Redis(url, {
    // Connect eagerly; ioredis queues commands until the connection is up.
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    ...tlsOptions
  })

  // ioredis reconnects on its own; this log is only an operator signal.
  client.on('error', (e: Error) => {
    log.warn('client error', { err: e })
  })

  return client
}

let subscriber: Redis | null = null

/**
 * Dedicated connection for pub/sub SUBSCRIBE (a subscribed ioredis
 * connection can't run normal commands). Same config as `useValkey()`;
 * ioredis re-subscribes its channels after a reconnect. Used by the AI
 * session stream (`agentic/sessionChannel.ts`).
 */
export function useValkeySubscriber(): Redis {
  if (subscriber) return subscriber
  subscriber = useValkey().duplicate()
  subscriber.on('error', (e: Error) => {
    log.warn('subscriber error', { err: e })
  })
  return subscriber
}

export async function closeValkey(): Promise<void> {
  const sub = subscriber
  subscriber = null
  if (sub) {
    try {
      await sub.quit()
    } catch {
      // Already closed — nothing to release.
    }
  }
  if (!client) return
  try {
    await client.quit()
  } finally {
    client = null
  }
}
