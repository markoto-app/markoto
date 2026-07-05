import { getCachedProbeResults, isOverallHealthy, type ProbeResult } from '../utils/healthProbes'

// Public status endpoint — purpose-built for an external status page (e.g.
// a scheduled GitHub Actions job that polls this and publishes to GitHub
// Pages). Reports EVERY component's up/down state so the page can render a
// per-component board (Postgres / Valkey / sync / S3 / renderer /
// markitdown / LiteLLM).
//
// Differs from the other two health routes on purpose:
//   - `/api/health` (Traefik gate) returns 200/503 and a MINIMAL body —
//     it exists to pull a node from rotation, not to describe the system.
//   - `/api/health/deep` (logged-in) returns latencies + error STRINGS.
//   - `/api/status` (this, public) returns per-component status + latency
//     but NO error strings (they can leak internal hostnames), and ALWAYS
//     200 — it's a status REPORT, not a liveness gate, so the poller's
//     fetch must succeed even when a component is down; the page derives
//     green/red from the body.
//
// Shares the TTL cache with `/api/health` via `getCachedProbeResults`, so
// polling it doesn't add a second fan-out onto the downstream deps.
//
// Public endpoint (whitelisted in `server/middleware/auth.ts`).

interface StatusCheck {
  status: ProbeResult['status']
  latencyMs: number
}

function pick(r: ProbeResult): StatusCheck {
  return { status: r.status, latencyMs: r.latencyMs }
}

export default defineEventHandler(async () => {
  const config = useRuntimeConfig()
  const results = await getCachedProbeResults({
    syncUrl: config.syncInternalUrl,
    rendererUrl: config.rendererInternalUrl,
    markitdownUrl: config.markitdownUrl,
    litellmUrl: config.litellm?.url,
    s3Bucket: config.s3?.bucket
  })

  return {
    // `ok` when every GATING component is up (S3 is non-gating — see
    // isOverallHealthy); the per-component board below still shows S3.
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
})
