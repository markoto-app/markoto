import { getCachedHealth } from '../utils/platform/healthProbes'

// Healthcheck for Traefik / docker-compose / on-call dashboards.
//
// Probes every critical dependency in parallel with a 1s per-probe timeout
// (`healthProbes.ts`): 200 only when EVERY probe passes, else 503 with a
// per-component breakdown. Traefik's `loadbalancer.healthcheck` treats 503 as
// unhealthy and stops routing, which is wanted: a node with degraded Valkey
// silently fails rate limits OPEN.
//
// Cache (`getCachedHealth`): healthy 5 s so polling doesn't fan out to the
// probed deps; degraded 2 s so a Valkey flap recovers fast.
//
// The body is minimal (no version, hostnames or timing); `/api/health/deep`
// returns latencies and is for instance admins only.
//
// Public (server/utils/auth/publicRoutes.ts).

export default defineApiHandler({
  access: allow.public('Liveness probe for Traefik, docker-compose and monitors; component status only, no hostnames or timings'),
  handler: async ({ event }) => {
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
  }
})
