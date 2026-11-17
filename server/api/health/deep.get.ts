import { runAllProbes, isOverallHealthy, probeEmbeddings, healthProbeUrlsFromEnv, type ProbeResult } from '../../utils/platform/healthProbes'

// Auth-gated deep healthcheck: the same probes as `/api/health` plus
// per-component latencies and (when down) the underlying error string.
//
// Uncached: it is rare, and `/api/health` absorbs the Traefik traffic.
//
// Admins only (`users.is_admin`): the error strings name internal hosts,
// ports and upstream failures, which only operators need.

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

export default defineApiHandler({
  access: allow.admin(),
  handler: async ({ event }) => {
    const embeddings = await probeEmbeddings()
    const results = await runAllProbes(healthProbeUrlsFromEnv())

    const healthy = isOverallHealthy(results)
    setResponseStatus(event, healthy ? 200 : 503)

    return {
      status: healthy ? 'ok' : 'degraded',
      checks: {
        postgres: pick(results.postgres),
        valkey: pick(results.valkey),
        sync: pick(results.sync),
        s3: pick(results.s3),
        // Informational like `embeddings`: the bucket's CORS rules cover
        // browser uploads from NUXT_SITE_URL (`skipped` when S3 shares the
        // site's origin or the store can't answer GetBucketCors).
        s3Cors: pick(results.s3Cors),
        renderer: pick(results.renderer),
        markitdown: pick(results.markitdown),
        litellm: pick(results.litellm),
        // Informational: "down" disables knowledge features only and does
        // not change the overall status or HTTP code.
        embeddings: pick(embeddings)
      }
    }
  }
})
