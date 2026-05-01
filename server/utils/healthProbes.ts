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
import { useDatabase } from './database'
import { useValkey } from './valkey'

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

async function probeHttp(url: string | undefined | null, name: string): Promise<ProbeResult> {
  if (!url) return skipped()
  const started = performance.now()
  try {
    const target = `${url.replace(/\/+$/, '')}/health`
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
    const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'timeout' : e.message) : String(e)
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

export interface HealthProbeUrls {
  syncUrl?: string | null
  rendererUrl?: string | null
  markitdownUrl?: string | null
}

export interface AllProbeResults {
  postgres: ProbeResult
  valkey: ProbeResult
  sync: ProbeResult
  renderer: ProbeResult
  markitdown: ProbeResult
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
    probeRenderer(urls.rendererUrl),
    probeMarkitdown(urls.markitdownUrl)
  ])
  const unwrap = (s: PromiseSettledResult<ProbeResult>): ProbeResult => {
    if (s.status === 'fulfilled') return s.value
    return down(0, s.reason instanceof Error ? s.reason.message : String(s.reason))
  }
  return {
    postgres: unwrap(settled[0]),
    valkey: unwrap(settled[1]),
    sync: unwrap(settled[2]),
    renderer: unwrap(settled[3]),
    markitdown: unwrap(settled[4])
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
  return Object.values(results).every(r => r.status !== 'down')
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

let cache: { expiresAt: number, value: CachedHealth } | null = null

function projectChecks(results: AllProbeResults): Record<string, ProbeStatus> {
  return {
    postgres: results.postgres.status,
    valkey: results.valkey.status,
    sync: results.sync.status,
    renderer: results.renderer.status,
    markitdown: results.markitdown.status
  }
}

export async function getCachedHealth(urls: HealthProbeUrls): Promise<CachedHealth> {
  if (cache && Date.now() < cache.expiresAt) {
    return cache.value
  }
  const results = await runAllProbes(urls)
  const healthy = isOverallHealthy(results)
  const value: CachedHealth = healthy
    ? { status: 200, body: { status: 'ok' } }
    : { status: 503, body: { status: 'degraded', checks: projectChecks(results) } }
  cache = {
    expiresAt: Date.now() + (healthy ? HEALTHY_TTL_MS : DEGRADED_TTL_MS),
    value
  }
  return value
}

export function _resetHealthCache(): void {
  cache = null
}
