interface RateLimitEntry {
  count: number
  resetAt: number
}

const stores = new Map<string, Map<string, RateLimitEntry>>()

/**
 * Simple in-memory rate limiter.
 * Returns true if the request should be allowed, false if rate-limited.
 */
export function checkRateLimit(
  namespace: string,
  key: string,
  maxAttempts: number,
  windowMs: number
): boolean {
  if (!stores.has(namespace)) {
    stores.set(namespace, new Map())
  }
  const store = stores.get(namespace)!
  const now = Date.now()

  const entry = store.get(key)
  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }

  if (entry.count >= maxAttempts) {
    return false
  }

  entry.count++
  return true
}

// Periodic cleanup of expired entries (every 5 minutes)
setInterval(() => {
  const now = Date.now()
  for (const store of stores.values()) {
    for (const [key, entry] of store) {
      if (now > entry.resetAt) {
        store.delete(key)
      }
    }
  }
}, 5 * 60 * 1000)
