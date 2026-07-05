import { getCachedHealth } from '../utils/healthProbes'

// Deep healthcheck for Traefik / docker-compose / on-call dashboards.
//
// Probes every critical dependency in parallel with a 1s per-probe timeout
// (see `healthProbes.ts`). Returns 200 only when EVERY probe passes;
// returns 503 with a per-component breakdown when any probe is `down`.
// 503 is correct semantics here: Traefik's `loadbalancer.healthcheck`
// treats 503 as unhealthy and stops sending traffic to the instance,
// which is what we want — a node with degraded Valkey is silently
// fail-OPENing rate limits and shouldn't be in rotation.
//
// Cache discipline (lives in `getCachedHealth`):
//   - Healthy results cached 5 s. Without the cache, every poll fans out
//     to 5 downstream probes and the endpoint itself becomes a DoS
//     amplifier on the deps it's trying to protect.
//   - Degraded results cached only 2 s so a Valkey flap recovers fast in
//     the dashboards.
//
// The body shape is intentionally minimal — no version, no internal
// hostnames, no timing. The deep variant `/api/health/deep` returns
// per-component latencies and requires a logged-in session.
//
// Public endpoint (whitelisted in `server/middleware/auth.ts`).

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const cached = await getCachedHealth({
    syncUrl: config.syncInternalUrl,
    rendererUrl: config.rendererInternalUrl,
    markitdownUrl: config.markitdownUrl,
    litellmUrl: config.litellm?.url,
    s3Bucket: config.s3?.bucket
  })
  setResponseStatus(event, cached.status)
  return cached.body
})
