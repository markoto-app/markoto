#!/usr/bin/env bun
import { spawn, type Subprocess } from 'bun'

// Orchestrator for `bun run flows:test:ephemeral`.
//
// 1. Bring up docker-compose.flows.yml (waits for healthchecks).
// 2. Run `bun run build` (production Nitro output to .output/).
// 3. Spawn `bun run .output/server/index.mjs` against the ephemeral
//    infra on port 3001.
// 4. Wait for /api/health to respond.
// 5. Run Playwright against http://localhost:3001.
// 6. Clean up on every exit path (success, test failure, Ctrl-C, crash).
//
// Why prod build over `bun run dev`:
//   • No Vite transform-on-first-request → no slow first test.
//   • No HMR cascade if the developer edits a file mid-test.
//   • No runtime dep discovery → no "cache invalidated, restart"
//     between tests (the bug that killed our mobile run twice).
//   • Catches real prod bugs the dev SSR papers over (lib0 conditional
//     exports, missing tracedeps, etc.).
// Cost: a one-time ~30-60s build at the top of every run. Worth it
// once we have more than a couple of flows.
//
// Why a script and not just package.json && chains: cleanup must run
// whether tests pass, fail, or get interrupted. trap is not portable
// across shells; an explicit catch + finally is.

// Single shared compose file for both integration tests + flow tests
// (see docker-compose.test.yml header). Flow tests need the extra
// sync + markitdown services, which live behind `--profile flows`.
const COMPOSE_FILE = 'docker-compose.test.yml'
const COMPOSE_PROFILE = 'flows'
const NUXT_PORT = 3001
const NUXT_URL = `http://localhost:${NUXT_PORT}`

// Env vars the Nuxt server needs to talk to the test infra. Mirrors
// .env but with shifted ports (5433/6380/8334/4002/8081 — see compose
// header) + isolated secrets that match what sync-test was built with.
const FLOWS_ENV: Record<string, string> = {
  PORT: String(NUXT_PORT),
  DATABASE_URL: 'postgres://ypad:testpassword@localhost:5433/ypad_test',
  VALKEY_URL: 'redis://localhost:6380/0',
  NUXT_S3_ENDPOINT: 'http://localhost:8334',
  NUXT_S3_ACCESS_KEY: 'ypad-access-key',
  NUXT_S3_SECRET_KEY: 'ypad-secret-key',
  NUXT_S3_BUCKET: 'ypad',
  NUXT_MARKITDOWN_URL: 'http://localhost:8081',
  NUXT_PUBLIC_SYNC_URL: 'ws://localhost:4002',
  NUXT_SYNC_INTERNAL_URL: 'http://localhost:4002',
  NUXT_JWT_SECRET: 'test-jwt-secret-isolated-from-dev-and-prod-stacks-64char',
  NUXT_INTERNAL_API_SECRET: 'test-internal-api-secret-isolated',
  NUXT_SESSION_PASSWORD: 'test-session-password-at-least-32-chars-isolated-x',
  // Stripe: prod-build runtime validation requires these. Tests don't
  // exercise billing UI, so dummy values that satisfy the shape are
  // enough. Aligns with the integration-test setup (see
  // tests/integration/setup/server.ts).
  NUXT_STRIPE_SECRET_KEY: 'sk_test_flows123',
  NUXT_STRIPE_WEBHOOK_SECRET: 'whsec_test_flows',
  NUXT_STRIPE_API_BASE: 'http://127.0.0.1:12111',
  NUXT_STRIPE_PRICE_PRO: 'price_test_pro',
  NUXT_STRIPE_PRICE_MAX: 'price_test_max',
  NUXT_STRIPE_PRICE_ULTRA: 'price_test_ultra',
  // Skip the inactive-doc sweep — short-lived test infra doesn't
  // benefit and the TTL math complains on a fresh DB.
  NUXT_INACTIVE_DOC_TTL_DAYS: '0'
}

let nuxtProc: Subprocess | null = null
let cleaningUp = false

async function shellOut(cmd: string[]): Promise<number> {
  // Explicit env: Bun.spawn without `env` doesn't reliably propagate
  // `process.env` mutations made AFTER orchestrator start (we set
  // PLAYWRIGHT_BASE_URL just before invoking Playwright). Without this,
  // Playwright's config falls through to BASE_URL='http://localhost:3000'
  // AND auto-spins its own webServer there — tests then hit a second
  // Nuxt on the wrong port and never reach the ephemeral stack.
  const proc = spawn({ cmd, env: process.env as Record<string, string>, stdout: 'inherit', stderr: 'inherit' })
  return await proc.exited
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) })
      // 200 = ready; 500 = ready-but-erroring (e.g. SSR error on first hit).
      // Both mean the server is accepting connections. 5xx will surface
      // through Playwright; we just need to know the server is up.
      if (r.status < 600) return
    } catch { /* connection refused etc — keep polling */ }
    await Bun.sleep(500)
  }
  throw new Error(`timed out waiting for ${url} after ${timeoutMs}ms`)
}

async function cleanup() {
  if (cleaningUp) return
  cleaningUp = true
  if (nuxtProc) {
    console.log('[flows-ephemeral] stopping Nuxt server')
    try { nuxtProc.kill('SIGTERM') } catch {}
    // Give Nuxt a moment to drain. SIGKILL after if it didn't exit.
    const t = setTimeout(() => { try { nuxtProc?.kill('SIGKILL') } catch {} }, 5000)
    await nuxtProc.exited.catch(() => {})
    clearTimeout(t)
  }
  console.log('[flows-ephemeral] tearing down docker stack')
  // NOTE: NO --remove-orphans here — that flag treats other compose
  // files in the same project namespace as orphans and removes them
  // (e.g. nuking dev containers). Down only stops what THIS profile
  // started; integration-test services + dev infra survive.
  await shellOut(['docker', 'compose', '-f', COMPOSE_FILE, '--profile', COMPOSE_PROFILE, 'down', '-v'])
}

async function main() {
  // Step 1: docker stack
  console.log('[flows-ephemeral] booting docker stack')
  const upCode = await shellOut(['docker', 'compose', '-f', COMPOSE_FILE, '--profile', COMPOSE_PROFILE, 'up', '-d', '--wait'])
  if (upCode !== 0) {
    console.error('[flows-ephemeral] docker compose up failed')
    process.exit(upCode)
  }

  // Step 2: production build. Skip with FLOWS_SKIP_BUILD=1 if you've
  // already got a fresh .output/ from a previous run AND haven't
  // touched app code (rare — most edits invalidate the bundle).
  if (process.env.FLOWS_SKIP_BUILD !== '1') {
    console.log('[flows-ephemeral] building production bundle')
    const buildCode = await shellOut(['bun', 'run', 'build'])
    if (buildCode !== 0) {
      console.error('[flows-ephemeral] bun run build failed')
      process.exit(buildCode)
    }
  } else {
    console.log('[flows-ephemeral] FLOWS_SKIP_BUILD=1 — reusing existing .output/')
  }

  // Step 3: spawn the production Nitro server (preset 'bun' →
  // .output/server/index.mjs runs under Bun directly). Env-overridden
  // to talk to the ephemeral infra.
  console.log(`[flows-ephemeral] starting production server on :${NUXT_PORT}`)
  nuxtProc = spawn({
    cmd: ['bun', 'run', '.output/server/index.mjs'],
    env: { ...process.env, ...FLOWS_ENV },
    stdout: 'inherit',
    stderr: 'inherit'
  })

  // Step 4: wait for it to respond.
  console.log(`[flows-ephemeral] waiting for ${NUXT_URL} to come up`)
  await waitForHttp(`${NUXT_URL}/api/health`, 60_000)

  // Step 5: Playwright. Pass through all argv so callers can scope to
  // a single test (e.g. `bun run flows:test:ephemeral --project=en-light-desktop`).
  console.log('[flows-ephemeral] running Playwright')
  const playwrightCode = await shellOut([
    'bunx', 'playwright', 'test',
    ...process.argv.slice(2)
  ])
  process.exitCode = playwrightCode
}

// Cleanup on every exit path. Even on uncaught throws (the catch
// re-throws after cleanup so the process still exits non-zero).
process.on('SIGINT', () => cleanup().then(() => process.exit(130)))
process.on('SIGTERM', () => cleanup().then(() => process.exit(143)))

try {
  // Tests run with PLAYWRIGHT_BASE_URL pointing at the ephemeral
  // server. Set it BEFORE main() so it's in scope when Playwright
  // starts.
  process.env.PLAYWRIGHT_BASE_URL = NUXT_URL
  await main()
} finally {
  await cleanup()
}
