import { runAllProbes, isOverallHealthy, type ProbeResult } from '../../utils/healthProbes'

// Auth-gated deep healthcheck. Same probes as `/api/health` but returns
// per-component latencies + (when down) the underlying error string.
// Used by on-call dashboards / a logged-in operator pulling a snapshot.
//
// Skips the cache: this endpoint is rare enough that fresh data is more
// valuable than amortising cost. The bare `/api/health` endpoint already
// absorbs the high-frequency Traefik traffic.
//
// Auth: bare `requireValidatedUserSession` — any logged-in user can read
// their own server's status. We don't gate on admin because the response
// only exposes liveness booleans + sub-millisecond latencies, no PII.

interface DeepCheck {
  status: ProbeResult['status']
  latencyMs: number
  error?: string
}

function pick(r: ProbeResult): DeepCheck {
  const out: DeepCheck = { status: r.status, latencyMs: r.latencyMs }
  if (r.error) out.error = r.error
  return out
}

export default defineEventHandler(async (event) => {
  await requireValidatedUserSession(event)

  const config = useRuntimeConfig()
  const results = await runAllProbes({
    syncUrl: config.syncInternalUrl,
    rendererUrl: config.rendererInternalUrl,
    markitdownUrl: config.markitdownUrl
  })

  const healthy = isOverallHealthy(results)
  setResponseStatus(event, healthy ? 200 : 503)

  return {
    status: healthy ? 'ok' : 'degraded',
    checks: {
      postgres: pick(results.postgres),
      valkey: pick(results.valkey),
      sync: pick(results.sync),
      renderer: pick(results.renderer),
      markitdown: pick(results.markitdown)
    }
  }
})
