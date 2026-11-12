import { getCachedProbeResults, isOverallHealthy, type ProbeResult } from '../utils/platform/healthProbes'
import { useEnv } from '~~/shared/env/load'

// Public status endpoint for an external status page (e.g. a scheduled job that
// polls this and publishes it). Reports EVERY component's up/down state
// (Postgres / Valkey / sync / S3 / renderer / markitdown / LiteLLM).
//
// Unlike the other health routes:
//   - `/api/health` (Traefik gate) returns 200/503 and a minimal body.
//   - `/api/health/deep` (admins) returns latencies + error strings.
//   - `/api/status` (public) returns status + latency but NO error strings
//     (they can leak internal hostnames), and ALWAYS 200: it is a report, not
//     a liveness gate, so the poller's fetch succeeds even when a component is
//     down and the page derives green/red from the body.
//
// Shares the TTL cache with `/api/health` (`getCachedProbeResults`), so
// polling adds no second fan-out.
//
// Public (server/utils/auth/publicRoutes.ts).

interface StatusCheck {
  status: ProbeResult['status']
  latencyMs: number
}

function pick(r: ProbeResult): StatusCheck {
  return { status: r.status, latencyMs: r.latencyMs }
}

export default defineApiHandler({
  access: allow.public('Status board for an external status page; up/down and latency per component, no error strings'),
  handler: async () => {
    const env = useEnv()
    const results = await getCachedProbeResults({
      syncUrl: env.sync.internalUrl,
      rendererUrl: env.renderer.internalUrl,
      markitdownUrl: env.markitdown.url,
      litellmUrl: env.litellm.url,
      s3Bucket: env.storage.bucket
    })

    return {
      // `ok` when every GATING component is up (S3 is non-gating, see
      // isOverallHealthy); the board below still shows S3.
      status: isOverallHealthy(results) ? 'ok' : 'degraded',
      checkedAt: new Date().toISOString(),
      checks: {
        postgres: pick(results.postgres),
        valkey: pick(results.valkey),
        sync: pick(results.sync),
        s3: pick(results.s3),
        renderer: pick(results.renderer),
        markitdown: pick(results.markitdown),
        litellm: pick(results.litellm)
      }
    }
  }
})
