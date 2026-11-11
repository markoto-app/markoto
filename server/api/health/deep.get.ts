import { runAllProbes, isOverallHealthy, probeEmbeddings, type ProbeResult } from '../../utils/platform/healthProbes'

// Auth-gated deep healthcheck: the same probes as `/api/health` plus
// per-component latencies and (when down) the underlying error string.
//
// Uncached: it is rare, and `/api/health` absorbs the Traefik traffic.
//
// Auth: any logged-in user, not admin-only, since the response exposes only
// liveness booleans and latencies, no PII.

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
  const embeddings = await probeEmbeddings()
  const results = await runAllProbes({
    syncUrl: config.syncInternalUrl,
    rendererUrl: config.rendererInternalUrl,
    markitdownUrl: config.markitdownUrl,
    litellmUrl: config.litellm?.url,
    s3Bucket: config.s3?.bucket
  })

  const healthy = isOverallHealthy(results)
  setResponseStatus(event, healthy ? 200 : 503)

  return {
    status: healthy ? 'ok' : 'degraded',
    checks: {
      postgres: pick(results.postgres),
      valkey: pick(results.valkey),
      sync: pick(results.sync),
      s3: pick(results.s3),
      renderer: pick(results.renderer),
      markitdown: pick(results.markitdown),
      litellm: pick(results.litellm),
      // Informational: "down" disables knowledge features only and does
      // not change the overall status or HTTP code.
      embeddings: pick(embeddings)
    }
  }
})
