import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  TEST_BASE_URL,
  TEST_DB_URL,
  TEST_INTERNAL_SECRET,
  TEST_JWT_SECRET,
  TEST_PORT,
  TEST_SESSION_PASSWORD,
  TEST_SYNC_URL,
  TEST_VALKEY_URL
} from './env'

// Nuxt dev-server subprocess lifecycle. Boot once for the whole test run
// from globalSetup, tear down at the end.
//
// We spawn `bun run dev` rather than building + booting the nitro output:
// - dev is faster to reach the first request
// - HMR is harmless here (no files change during a test run)
// - runtime config picks up the `NUXT_*` env vars we set below exactly
//   the same way production does
//
// Downside: startup is ~8-15s depending on cold caches. One-off cost paid
// once per `bun run test:integration` invocation.

let proc: ChildProcess | null = null

const BOOT_TIMEOUT_MS = 90_000

export async function startNuxt(): Promise<void> {
  if (proc) return

  // Every secret / URL the app reads via useRuntimeConfig() at request time.
  // Keep this list aligned with nuxt.config.ts's runtimeConfig shape —
  // missing a var leaves a runtime default in place (usually '') which
  // shows up as a confusing 500 deep inside a handler.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    TEST_MODE: '1',
    NITRO_PORT: String(TEST_PORT),
    PORT: String(TEST_PORT),
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    VALKEY_URL: TEST_VALKEY_URL,
    NUXT_SESSION_PASSWORD: TEST_SESSION_PASSWORD,
    NUXT_JWT_SECRET: TEST_JWT_SECRET,
    NUXT_INTERNAL_API_SECRET: TEST_INTERNAL_SECRET,
    NUXT_SYNC_INTERNAL_URL: TEST_SYNC_URL,
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
    NUXT_GOOGLE_GEMINI_API_KEY: 'test',
    NUXT_GOOGLE_SPEECH_TO_TEXT_API_KEY: 'test',
    // Substitutes a fake SpeechClient for the dictation WS route so
    // integration tests can drive the full handshake and message
    // flow without hitting Google or paying per-minute. See
    // `server/utils/agentic/dictateSpeechClient.ts`.
    NUXT_GOOGLE_SPEECH_MOCK: '1',
    NUXT_MARKITDOWN_URL: 'http://127.0.0.1:1',
    // Stripe: tests talk to the `stripe-mock` container for SDK calls
    // (checkout, portal) and construct webhook payloads locally with
    // `computeStripeSig` using this same secret.
    // stripe-mock accepts any key matching `sk_test_<alphanumeric>`;
    // use a short suffix that matches their example format.
    NUXT_STRIPE_SECRET_KEY: 'sk_test_123abc',
    NUXT_STRIPE_WEBHOOK_SECRET: 'whsec_test_integration',
    NUXT_STRIPE_API_BASE: 'http://127.0.0.1:12111',
    NUXT_STRIPE_PRICE_PRO: 'price_test_pro',
    NUXT_STRIPE_PRICE_MAX: 'price_test_max',
    NUXT_STRIPE_PRICE_ULTRA: 'price_test_ultra',
    // Inactive-doc sweeper. Set TTL to 0 to disable for tests — no point
    // letting it fire during a short integration run.
    NUXT_INACTIVE_DOC_TTL_DAYS: '0'
  }

  proc = spawn('bun', ['run', 'dev', '--host', '127.0.0.1'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  })

  // Forward stderr so boot failures surface in the test log. Dev-server
  // stdout is chatty (HMR, nitro prep, etc.) — gate on DEBUG to see it.
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
    try { p.kill('SIGKILL') } catch { /* already gone */ }
  }, 3000)
  await new Promise<void>((resolve) => {
    if (p.exitCode !== null) { resolve(); return }
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
      const res = await fetch(`${TEST_BASE_URL}/api/health`, {
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
