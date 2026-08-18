import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_BASE_URL, TEST_PORT } from './env'
import { buildTestEnv } from './testEnv'

// Production Nitro subprocess lifecycle. Boot once for the whole test run
// from globalSetup, tear down at the end.
//
// Why prod build (not `bun run dev`):
//   - dev mode's WS upgrade handler doesn't reliably wire up under our
//     Bun + Nuxt + crossws stack — the `/api/ai/dictate` route hangs on
//     handshake instead of firing `open`. The prod preset binds the
//     upgrade handler directly via `crossws/adapters/node` against the
//     Node `http.Server`, which works.
//   - Tests run against the SAME bundle that ships to prod; catches
//     prod-only bugs that the dev SSR transform papers over (lib0
//     conditional exports, missing `traceInclude` deps, etc.).
//   - First-request latency vanishes — no Vite transform-on-first-hit.
//
// Cost: a one-time `bun run build` (~30-60s) at the top of the run.
// Skip with `INTEGRATION_SKIP_BUILD=1` if you've already got a fresh
// .output/ from a previous run AND haven't touched app code (rare —
// most edits invalidate the bundle).

let proc: ChildProcess | null = null

const BOOT_TIMEOUT_MS = 90_000
const OUTPUT_ENTRY = '.output/server/index.mjs'

export async function startNuxt(): Promise<void> {
  if (proc) return

  // Step 1: production build, unless explicitly skipped. Done synchronously
  // because there's no point streaming progress — vitest holds the test
  // worker until globalSetup resolves anyway, and a 30-60s pause with no
  // output is normal.
  if (process.env.INTEGRATION_SKIP_BUILD !== '1' || !existsSync(OUTPUT_ENTRY)) {
    if (process.env.INTEGRATION_SKIP_BUILD === '1' && !existsSync(OUTPUT_ENTRY)) {
      console.log('[integration] INTEGRATION_SKIP_BUILD=1 set but no .output/ found — building anyway.')
    } else {
      console.log('[integration] building production bundle (~30-60s, set INTEGRATION_SKIP_BUILD=1 to reuse .output/ between runs)...')
    }
    const buildResult = spawnSync('bun', ['run', 'build'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    })
    if (buildResult.status !== 0) {
      const stderr = buildResult.stderr?.toString() ?? '(no stderr)'
      throw new Error(`[integration] bun run build failed (status=${buildResult.status}):\n${stderr}`)
    }
  } else {
    console.log('[integration] INTEGRATION_SKIP_BUILD=1 — reusing existing .output/')
  }

  // Step 2: env for the prod runtime. nuxt.config.ts pins
  // `nitro.preset: 'bun'`, so the entry point is `.output/server/index.mjs`
  // run under Bun. NODE_ENV must be 'production' so error pages render
  // and runtime config picks up the prod values; TEST_MODE=1 still gates
  // the in-process test fakes (Speech mock, etc.).
  //
  // The connection-string vars (DATABASE_URL + atomic POSTGRES_* /
  // VALKEY_*) and test secrets come from `buildTestEnv()` — the same
  // helper repo tests use, so a future env-wiring change has ONE place
  // to update. Everything else (NUXT_* runtime config) is owned here
  // because it's specific to the integration subprocess shape.
  //
  // Keep this list aligned with nuxt.config.ts's runtimeConfig shape —
  // missing a var leaves a runtime default in place (usually '') which
  // shows up as a confusing 500 deep inside a handler.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...buildTestEnv(),
    NODE_ENV: 'production',
    // The Phase-9 hardening enables Postgres TLS by default in
    // production (resolvePostgresSsl in shared/utils/postgresSsl.ts
    // returns `{rejectUnauthorized: true}` whenever NODE_ENV=production).
    // The local test Postgres container speaks plaintext only, so the
    // prod-build subprocess would fail boot with "The server does not
    // support SSL connections" without an explicit opt-out here.
    PGSSL: 'disable',
    // Bind to all interfaces so the renderer container can reach the
    // test Nuxt subprocess via host.docker.internal:3101. Loopback-only
    // (127.0.0.1) was fine when every test caller was in-process; the
    // real renderer runs in docker and reaches us through the bridge
    // gateway, which 127.0.0.1 refuses.
    HOST: '0.0.0.0',
    // S3 config points at the test SeaweedFS. Most tests don't upload
    // anything, but the presigner initialises its client lazily and
    // would throw on first use without these.
    NUXT_S3_ENDPOINT: 'http://127.0.0.1:8334',
    NUXT_S3_ACCESS_KEY: 'ypad-access-key',
    NUXT_S3_SECRET_KEY: 'ypad-secret-key',
    NUXT_S3_BUCKET: 'ypad',
    // OAuth + AI not exercised by these tests — stub values keep Nuxt
    // from failing boot assertions.
    NUXT_OAUTH_GITHUB_CLIENT_ID: 'test',
    NUXT_OAUTH_GITHUB_CLIENT_SECRET: 'test',
    NUXT_OAUTH_GOOGLE_CLIENT_ID: 'test',
    NUXT_OAUTH_GOOGLE_CLIENT_SECRET: 'test',
    NUXT_GOOGLE_API_KEY: 'test',
    // LiteLLM proxy. Phase 7: integration tests hit a real `litellm-test`
    // container (docker-compose.test.yml) on port 4100 so the per-user
    // virtual-key CRUD round-trips through the actual /key/* admin
    // surface. Knowledge embeddings retain the legacy provider tag
    // (pre-Phase-5 Gemini-era) for tests that exercise the dual-mode
    // resolver branch — no model upstream is wired in the test proxy.
    NUXT_LITELLM_URL: 'http://127.0.0.1:4100',
    NUXT_LITELLM_MASTER_KEY: 'sk-test-litellm-master',
    // Test stack uses `litellm_test` (alongside `ypad_test`) on the
    // shared `postgres-test` container; `axis-spend` and `spend-logs-sweep`
    // both connect directly to query/maintain LiteLLM_SpendLogs.
    NUXT_LITELLM_DB_NAME: 'litellm_test',
    // Phase 6 collapsed `NUXT_KNOWLEDGE_EMBEDDINGS_PROVIDER` to a single
    // value (`jina`) when the Gemini path was retired. Left at the
    // default in tests; the env var still exists but no longer toggles
    // a runtime branch.
    // Substitutes a fake SpeechClient for the dictation WS route so
    // integration tests can drive the full handshake and message
    // flow without hitting Voxtral Realtime or paying per-minute.
    // (Env var name carried over from pre-Phase-5 Cloud STT mock.)
    // See `server/utils/agentic/dictateSpeechClient.ts`.
    NUXT_GOOGLE_SPEECH_MOCK: '1',
    NUXT_MARKITDOWN_URL: 'http://127.0.0.1:1',
    // Stripe: tests talk to the `stripe-mock` container for SDK calls
    // (checkout, portal) and construct webhook payloads locally with
    // `computeStripeSig` using this same secret.
    // stripe-mock accepts any key matching `sk_test_<alphanumeric>`;
    // use a short suffix that matches their example format.
    // Email: force stub mode. sendEmail.ts auto-enables real Resend
    // delivery when RESEND_API_KEY is present, and the developer's .env
    // (loaded by the spawned Nuxt subprocess) may carry a REAL key —
    // without this, integration tests fire live Resend API calls
    // (observed: sandbox-mode rejections in the test logs). Tests
    // assert on state, never on delivered email, so stub is correct.
    NUXT_EMAIL_PROVIDER: 'stub',
    NUXT_STRIPE_SECRET_KEY: 'sk_test_123abc',
    NUXT_STRIPE_WEBHOOK_SECRET: 'whsec_test_integration',
    NUXT_STRIPE_API_BASE: 'http://127.0.0.1:12111',
    NUXT_STRIPE_PRICE_PRO: 'price_test_pro',
    NUXT_STRIPE_PRICE_MAX: 'price_test_max',
    NUXT_STRIPE_PRICE_ULTRA: 'price_test_ultra',
    // Inactive-doc sweeper. Set TTL to 0 to disable for tests — no point
    // letting it fire during a short integration run.
    NUXT_INACTIVE_DOC_TTL_DAYS: '0',
    // Real renderer container (docker-compose.test.yml renderer-test).
    // Hosts on :9101, drives Playwright + headless Chromium through the
    // actual print page. Tests that need the full render pipeline talk
    // to this. The stub-based path is gone — it couldn't catch
    // browser/SSR-layer bugs (oklch in Nuxt UI styles, zod imports
    // wedging Vite SSR, etc.).
    NUXT_RENDERER_INTERNAL_URL: 'http://127.0.0.1:9101'
  }

  // Boot guard: validate the resolved env we're about to hand the
  // subprocess. The `...process.env` spread above means a missed
  // POSTGRES_* override would silently fall through to the dev value
  // loaded from .env. If the resulting env points at the dev DB, refuse
  // to spawn — fail loud at the boundary instead of letting migrations
  // mutate dev data. (`postgresUrlFromEnv` enforces the same gate one
  // layer deeper in case anything bypasses this setup path.)
  if (env.POSTGRES_DB === 'ypad' || env.POSTGRES_PORT === '5432') {
    throw new Error(
      `[integration] refusing to spawn Nuxt with dev DB env: `
      + `POSTGRES_DB=${env.POSTGRES_DB} POSTGRES_PORT=${env.POSTGRES_PORT}. `
      + `Override these to point at ypad_test on :5433.`
    )
  }

  // Step 3: spawn the prod server.
  console.log(`[integration] starting production server on :${TEST_PORT}`)
  proc = spawn('bun', ['run', join(process.cwd(), OUTPUT_ENTRY)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  })

  // Forward stderr so boot failures surface in the test log. Prod
  // stdout is much quieter than dev — gate it on DEBUG anyway in case
  // a developer wants to see "listening on :3101" etc.
  proc.stderr?.on('data', (d) => {
    process.stderr.write(`[nuxt-test] ${d}`)
  })
  if (process.env.DEBUG_NUXT_TEST === '1') {
    proc.stdout?.on('data', (d) => {
      process.stdout.write(`[nuxt-test] ${d}`)
    })
  }
  proc.on('exit', (code, signal) => {
    // Only surface unexpected exits. null + SIGTERM means we killed it.
    if (proc && code !== null && code !== 0) {
      console.error(`[nuxt-test] server exited code=${code} signal=${signal}`)
    }
  })

  await waitForHealth()
}

export async function stopNuxt(): Promise<void> {
  if (!proc) return
  const p = proc
  proc = null
  p.kill('SIGTERM')
  // Nitro has a small graceful-shutdown window; give it ~3s before SIGKILL.
  const killTimer = setTimeout(() => {
    try {
      p.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }, 3000)
  await new Promise<void>((resolve) => {
    if (p.exitCode !== null) {
      resolve()
      return
    }
    p.once('exit', () => resolve())
  })
  clearTimeout(killTimer)
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    if (!proc || proc.exitCode !== null) {
      throw new Error(`[nuxt-test] subprocess exited before becoming healthy (code=${proc?.exitCode})`)
    }
    try {
      // `/api/version` is a tiny handler that returns 200 once Nitro is
      // up, with no dependency probes. The deep `/api/health` would 503
      // here because the test env points markitdown at a black-hole port
      // and may not have the sync container running — that's a
      // configuration-aware decision, not a "boot failed" signal.
      const res = await fetch(`${TEST_BASE_URL}/api/version`, {
        signal: AbortSignal.timeout(1500)
      })
      if (res.ok) return
      lastErr = new Error(`health check responded ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    await sleep(500)
  }
  throw new Error(`[nuxt-test] not healthy after ${BOOT_TIMEOUT_MS}ms: ${lastErr instanceof Error ? lastErr.message : lastErr}`)
}
