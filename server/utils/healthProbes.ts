// Per-component liveness probes for /api/health and /api/health/deep.
//
// Each probe is short, parallel-safe, and bounded by a sub-second timeout
// so a single slow dependency never gates the others. Probes catch every
// error and return a structured result rather than throwing — the caller
// runs them via `Promise.allSettled` and aggregates outcomes.
//
// HTTP probes accept either a configured URL (returning 'ok' on 2xx) or
// a missing/empty URL string (returning 'skipped'). The skip path matters
// for test environments and for self-hosted deployments that opt out of
// the renderer or markitdown sidecars: an unconfigured optional dependency
// shouldn't flag the whole instance as degraded. Sync + Postgres + Valkey
// are NOT skippable — they're hard-required for any prod path.

import { sql } from 'drizzle-orm'
import { HeadBucketCommand } from '@aws-sdk/client-s3'
import { useDatabase } from './database'
import { useValkey } from './valkey'
import { useS3Client } from './s3'

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
  return { status: 'down', latencyMs, error }
}

function skipped(): ProbeResult {
  return { status: 'skipped', latencyMs: 0 }
}

// Race a promise against a timeout that rejects with a stable label so
// callers can distinguish timeouts from connection-level failures in the
// optional `error` field on the deep endpoint.
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
    const db = useDatabase()
    // SET LOCAL only takes effect inside a transaction; use a plain query
    // wrapped in a JS-side timeout instead so we don't pay for an extra
    // round-trip just to set a session GUC.
    await withTimeout(db.execute(sql`SELECT 1`), PROBE_TIMEOUT_MS)
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

// Object-storage liveness. HeadBucket is the cheapest "is the bucket
// reachable + do my credentials work" check (no object read/list). Takes
// the bucket as a param — like the HTTP probes take a URL — so the probe
// stays pure/testable and skips cleanly when S3 isn't configured (test
// envs / self-hosted opt-outs). Uses the shared singleton client.
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
    const target = `${url.replace(/\/+$/, '')}${path}`
    const res = await fetch(target, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      // GET — every sidecar's /health is a plain text 200.
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

export function probeSync(url: string | undefined | null): Promise<ProbeResult> {
  return probeHttp(url, 'sync')
}

export function probeRenderer(url: string | undefined | null): Promise<ProbeResult> {
  return probeHttp(url, 'renderer')
}

export function probeMarkitdown(url: string | undefined | null): Promise<ProbeResult> {
  return probeHttp(url, 'markitdown')
}

// LiteLLM exposes /health/liveliness (NOT /health) — keep it on the
// liveliness probe rather than the deeper /health/readiness, which
// also checks DB+cache connectivity and would couple our health to
// LiteLLM's own dependency graph.
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

// Run every probe in parallel via Promise.allSettled. Any thrown error
// (which probe functions already swallow) is converted to a `down` result
// so the caller never sees a `rejected` settlement — keeps the aggregator
// simple.
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

// "Healthy overall" rule: every NON-skipped probe must be `ok`. Skipped
// probes (unconfigured optional deps) don't count against health; an
// instance that hasn't been wired to the renderer is still serving its
// primary path. Postgres/Valkey/Sync are passed live URLs in prod and so
// are never skipped — a skip on those would silently green a misconfigured
// deploy, which we accept here because compose `${VAR:?required}` already
// fails fast at boot for those vars.
export function isOverallHealthy(results: AllProbeResults): boolean {
  // S3 is deliberately EXCLUDED from the rotation gate. Object storage
  // backs image uploads, knowledge originals, and backups — NOT the core
  // doc-edit path (Y.js state lives in Postgres). An S3 outage should show
  // as degraded on the status page but must NOT return 503 here: Traefik
  // treats 503 as "pull this node", and on a single-instance deployment
  // that takes the WHOLE site down for something that only breaks uploads.
  // S3 is still reported in /api/status + /api/health/deep. (renderer /
  // markitdown / litellm remain gating — pre-existing behaviour.)
  const { s3: _s3, ...gating } = results
  return Object.values(gating).every(r => r.status !== 'down')
}

// ─── Cached aggregator ────────────────────────────────────────────────────
//
// Wraps `runAllProbes` with a TTL'd in-memory cache. Healthy results live
// 5 s (the typical poll interval is ≥10 s, so consecutive polls don't
// re-fan-out); degraded results live 2 s so a transient flap recovers
// quickly in the dashboards. Module-level state — exported `_resetCache`
// is for tests only.

export interface CachedHealth {
  status: number
  body: { status: 'ok' } | { status: 'degraded', checks: Record<string, ProbeStatus> }
}

const HEALTHY_TTL_MS = 5_000
const DEGRADED_TTL_MS = 2_000

// One cache entry holds BOTH the raw probe results (for /api/status) and
// the derived minimal health body (for /api/health), so the two endpoints
// share a single fan-out per TTL window instead of each amplifying onto
// the downstream deps. `health` is memoised alongside `results` so
// `getCachedHealth` keeps returning a stable object within the window.
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

// Full per-component results behind the same TTL cache — powers the public
// `/api/status` endpoint (which reports every component, always 200, for a
// status page to render) without a second fan-out onto the deps.
export async function getCachedProbeResults(urls: HealthProbeUrls): Promise<AllProbeResults> {
  return (await getCacheEntry(urls)).results
}

export function _resetHealthCache(): void {
  cache = null
}
