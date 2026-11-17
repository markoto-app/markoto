import { getCachedHealth, healthProbeUrlsFromEnv } from '../utils/platform/healthProbes'

// Health of the whole instance, for deploys, monitors and on-call dashboards.
//
// Probes every critical dependency in parallel with a 1s per-probe timeout
// (`healthProbes.ts`): 200 only when EVERY probe passes, else 503 with a
// per-component breakdown. Not the routing gate: Traefik and the container
// healthcheck use `/api/health/live` (Postgres + Valkey only), so a restart
// of sync or a sidecar does not take every page offline.
//
// Cache (`getCachedHealth`): healthy 5 s so polling doesn't fan out to the
// probed deps; degraded 2 s so a Valkey flap recovers fast.
//
// The body is minimal (no version, hostnames or timing); `/api/health/deep`
// returns latencies and is for instance admins only.
//
// Public (server/utils/auth/publicRoutes.ts).

export default defineApiHandler({
  access: allow.public('Instance health for deploys and monitors; component status only, no hostnames or timings'),
  handler: async ({ event }) => {
    const cached = await getCachedHealth(healthProbeUrlsFromEnv())
    setResponseStatus(event, cached.status)
    return cached.body
  }
})
