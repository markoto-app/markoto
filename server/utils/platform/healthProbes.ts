// Per-component liveness probes for /api/health and /api/health/deep.
//
// Each probe is bounded by a sub-second timeout so a slow dependency never
// gates the others, and returns a structured result instead of throwing.
//
// A probe with no configured URL returns 'skipped': an unconfigured optional
// sidecar (renderer, markitdown) must not flag the instance as degraded.
// Sync, Postgres and Valkey are hard-required and never skipped.

import { HeadBucketCommand } from '@aws-sdk/client-s3'
import { pingDatabase } from '../../repos/health'
import { useValkey } from './valkey'
import { useS3Client } from '../storage/s3'
import { getKnowledgeEmbeddingsStatus } from '../knowledge/knowledgeEmbeddingsStatus'
import { trimTrailingSlashes } from '../../../shared/utils/trimTrailingSlashes'
import { scrubText } from '../../../shared/utils/security/sentryScrub'

export type ProbeStatus = 'ok' | 'down' | 'skipped'

export interface ProbeResult {
  status: ProbeStatus
  latencyMs: number
  error?: string
}

const PROBE_TIMEOUT_MS = 1000

function ok(latencyMs: number): ProbeResult {
  return { status: 'ok', latencyMs }
}

function down(latencyMs: number, error: string): ProbeResult {
  // Driver errors can quote a connection string or URL (credentials in the
  // userinfo or query); the deep endpoint shows only the scrubbed text.
  return { status: 'down', latencyMs, error: scrubText(error, 300) }
}

function skipped(): ProbeResult {
  return { status: 'skipped', latencyMs: 0 }
}

// Rejects with the stable label 'timeout' so the deep endpoint's `error`
// field distinguishes timeouts from connection failures.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

export async function probePostgres(): Promise<ProbeResult> {
  const started = performance.now()
  try {
    // JS-side timeout: SET LOCAL statement_timeout would need a transaction
    // and an extra round-trip.
    await withTimeout(pingDatabase(), PROBE_TIMEOUT_MS)
    return ok(Math.round(performance.now() - started))
  } catch (e) {
    return down(Math.round(performance.now() - started), e instanceof Error ? e.message : String(e))
  }
}

export async function probeValkey(): Promise<ProbeResult> {
  const started = performance.now()
  try {
    const client = useValkey()
    await withTimeout(client.ping(), PROBE_TIMEOUT_MS)
    return ok(Math.round(performance.now() - started))
  } catch (e) {
    return down(Math.round(performance.now() - started), e instanceof Error ? e.message : String(e))
  }
}

// HeadBucket is the cheapest "bucket reachable and credentials work" check.
// The bucket is a parameter so the probe is testable and skips when S3 is
// not configured.
export async function probeS3(bucket: string | undefined | null): Promise<ProbeResult> {
  if (!bucket) return skipped()
  const started = performance.now()
  try {
    await withTimeout(
      useS3Client().send(new HeadBucketCommand({ Bucket: bucket })),
      PROBE_TIMEOUT_MS
    )
    return ok(Math.round(performance.now() - started))
  } catch (e) {
    return down(Math.round(performance.now() - started), e instanceof Error ? e.message : String(e))
  }
}

function errorMessage(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  return e.name === 'TimeoutError' ? 'timeout' : e.message
}

async function probeHttp(url: string | undefined | null, name: string, path = '/health'): Promise<ProbeResult> {
  if (!url) return skipped()
  const started = performance.now()
  try {
    const target = `${trimTrailingSlashes(url)}${path}`
    const res = await fetch(target, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      method: 'GET'
    })
    const latency = Math.round(performance.now() - started)
    if (res.ok) return ok(latency)
    return down(latency, `HTTP ${res.status}`)
  } catch (e) {
    const latency = Math.round(performance.now() - started)
    const msg = errorMessage(e)
    return down(latency, `${name}: ${msg}`)
  }
}

/**
 * Knowledge-base embeddings configuration vs. the stored vector column.
 * Reported on /api/health/deep only: deliberately NOT part of
 * `isOverallHealthy` (a knowledge misconfiguration must not 503 the app out
 * of rotation; the editor keeps working).
 */
export async function probeEmbeddings(): Promise<ProbeResult> {
  const started = performance.now()
  const status = await getKnowledgeEmbeddingsStatus()
  const latency = Math.round(performance.now() - started)
  return status.ok ? ok(latency) : down(latency, status.message)
}

export function probeSync(url: string | undefined | null): Promise<ProbeResult> {
  return probeHttp(url, 'sync')
}

export function probeRenderer(url: string | undefined | null): Promise<ProbeResult> {
  return probeHttp(url, 'renderer')
}

export function probeMarkitdown(url: string | undefined | null): Promise<ProbeResult> {
  return probeHttp(url, 'markitdown')
}

// LiteLLM's liveness path is /health/liveliness. Not /health/readiness: that
// also checks LiteLLM's DB and cache and would couple our health to its
// dependency graph.
export function probeLitellm(url: string | undefined | null): Promise<ProbeResult> {
  return probeHttp(url, 'litellm', '/health/liveliness')
}

export interface HealthProbeUrls {
  syncUrl?: string | null
  rendererUrl?: string | null
  markitdownUrl?: string | null
  litellmUrl?: string | null
  s3Bucket?: string | null
}

export interface AllProbeResults {
  postgres: ProbeResult
  valkey: ProbeResult
  sync: ProbeResult
  s3: ProbeResult
  renderer: ProbeResult
  markitdown: ProbeResult
  litellm: ProbeResult
}

// Runs every probe in parallel; a rejected settlement becomes a `down` result.
export async function runAllProbes(urls: HealthProbeUrls): Promise<AllProbeResults> {
  const settled = await Promise.allSettled([
    probePostgres(),
    probeValkey(),
    probeSync(urls.syncUrl),
    probeS3(urls.s3Bucket),
    probeRenderer(urls.rendererUrl),
    probeMarkitdown(urls.markitdownUrl),
    probeLitellm(urls.litellmUrl)
  ])
  const unwrap = (s: PromiseSettledResult<ProbeResult>): ProbeResult => {
    if (s.status === 'fulfilled') return s.value
    return down(0, s.reason instanceof Error ? s.reason.message : String(s.reason))
  }
  return {
    postgres: unwrap(settled[0]),
    valkey: unwrap(settled[1]),
    sync: unwrap(settled[2]),
    s3: unwrap(settled[3]),
    renderer: unwrap(settled[4]),
    markitdown: unwrap(settled[5]),
    litellm: unwrap(settled[6])
  }
}

// Healthy means every non-skipped probe is `ok`. Skipped probes (unconfigured
// optional deps) don't count. Postgres/Valkey/Sync are never skipped in prod:
// compose `${VAR:?required}` fails the boot if their config is missing.
export function isOverallHealthy(results: AllProbeResults): boolean {
  // S3 is deliberately excluded from the rotation gate. It backs uploads,
  // knowledge originals and backups, not the core doc-edit path (Y.js state
  // lives in Postgres). Traefik treats 503 as "pull this node", so on a
  // single instance an S3 outage would take the whole site down. S3 is still
  // reported in /api/status + /api/health/deep. Renderer, markitdown and
  // litellm do gate.
  const { s3: _s3, ...gating } = results
  return Object.values(gating).every(r => r.status !== 'down')
}

// `runAllProbes` behind a TTL cache: healthy results live 5 s so consecutive
// polls don't re-fan-out, degraded ones 2 s so a transient flap recovers
// quickly. `_resetHealthCache` is for tests only.

export interface CachedHealth {
  status: number
  body: { status: 'ok' } | { status: 'degraded', checks: Record<string, ProbeStatus> }
}

const HEALTHY_TTL_MS = 5_000
const DEGRADED_TTL_MS = 2_000

// One entry holds both the raw results (/api/status) and the derived health
// body (/api/health), so the two endpoints share one fan-out per TTL window.
interface HealthCacheEntry {
  expiresAt: number
  results: AllProbeResults
  health: CachedHealth
}

let cache: HealthCacheEntry | null = null

function projectChecks(results: AllProbeResults): Record<string, ProbeStatus> {
  return {
    postgres: results.postgres.status,
    valkey: results.valkey.status,
    sync: results.sync.status,
    s3: results.s3.status,
    renderer: results.renderer.status,
    markitdown: results.markitdown.status,
    litellm: results.litellm.status
  }
}

async function getCacheEntry(urls: HealthProbeUrls): Promise<HealthCacheEntry> {
  if (cache && Date.now() < cache.expiresAt) {
    return cache
  }
  const results = await runAllProbes(urls)
  const healthy = isOverallHealthy(results)
  const health: CachedHealth = healthy
    ? { status: 200, body: { status: 'ok' } }
    : { status: 503, body: { status: 'degraded', checks: projectChecks(results) } }
  cache = {
    expiresAt: Date.now() + (healthy ? HEALTHY_TTL_MS : DEGRADED_TTL_MS),
    results,
    health
  }
  return cache
}

export async function getCachedHealth(urls: HealthProbeUrls): Promise<CachedHealth> {
  return (await getCacheEntry(urls)).health
}

// Full per-component results for the public `/api/status` endpoint (always 200),
// sharing the same cache.
export async function getCachedProbeResults(urls: HealthProbeUrls): Promise<AllProbeResults> {
  return (await getCacheEntry(urls)).results
}

export function _resetHealthCache(): void {
  cache = null
}
