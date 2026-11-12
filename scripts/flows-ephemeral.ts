#!/usr/bin/env bun
import { spawn, type Subprocess } from 'bun'
import { testRoutesInBuild } from './lib/testRoutesInBuild'

// Orchestrator for `bun run flows:test`. Hermetic, end-to-end.
//
// 1. Bring up deploy/compose/compose.test.yml with the flows profile (waits for healthchecks).
// 2. Run `bun run build` (production Nitro output to .output/).
// 3. Spawn `bun run .output/server/index.mjs` against the ephemeral
//    infra on port 3001.
// 4. Wait for /api/health to respond.
// 5. Run Playwright against http://markoto.localhost:3001.
// 6. Clean up on every exit path (success, test failure, Ctrl-C, crash).
//
// Why a production build instead of `bun run dev`: no Vite transform on the
// first request, no HMR or dependency re-optimisation mid-run, and it
// catches production-only bugs (lib0 conditional exports, missing traced
// deps). Cost: a 30-60 s build at the top of every run.
//
// Why a script and not package.json `&&` chains: cleanup must run whether
// tests pass, fail or get interrupted, and `trap` is not portable across
// shells.

// One compose file serves integration and flow tests; flows need the extra
// sync + markitdown services behind `--profile flows`. The wrapper runs
// `docker compose -f deploy/compose/compose.test.yml` (+ the Podman overlay on
// Podman, docs/contributing/CONTAINER-ENGINES.md).
const TEST_COMPOSE = `${import.meta.dir}/test-compose.sh`
const COMPOSE_PROFILE = 'flows'
const NUXT_PORT = 3001
// The flows browse the app as `markoto.localhost` rather than `localhost`:
// share dialogs, copied links and QR codes print `location.origin`, and the
// screenshots are documentation. `*.localhost` is loopback by definition
// (RFC 6761 — Chromium and systemd-resolved / Bun resolve it to 127.0.0.1
// without any hosts entry) and still counts as a loopback NUXT_SITE_URL for
// the TEST_MODE guard (shared/utils/security/testMode.ts), so nothing is faked: the
// URL in a frame is the URL the browser really loaded.
const NUXT_URL = `http://markoto.localhost:${NUXT_PORT}`

// Env vars the Nuxt server needs to talk to the test infra: the dev `.env`
// with shifted ports (5433/6380/8334/4002/8081) and isolated secrets that
// match what the test containers were built with. AI flows
// (`tests/e2e/flows/ai-*.spec.ts`) run against the litellm-test container.
const FLOWS_ENV: Record<string, string> = {
  PORT: String(NUXT_PORT),
  // TEST_MODE enables /api/_test/login (the flow fixture seals a session
  // cookie without OAuth). It does not bypass the LLM upstream: every AI
  // call still hits the live LiteLLM proxy.
  TEST_MODE: '1',
  // Swap Voxtral Realtime for the canned-fake SpeechClient
  // (`server/utils/agentic/dictateSpeechClient.ts`); the live API returns
  // nothing recognisable for voice-dictate.spec.ts's synthetic 16 kHz tone.
  NUXT_VOXTRAL_REALTIME_MOCK: '1',
  // Atomic Postgres parts, read by `postgresUrlFromEnv`. Without them the
  // Nitro subprocess inherits the shell's dev vars and migrates the DEV
  // database.
  POSTGRES_USER: 'ypad',
  POSTGRES_PASSWORD: 'testpassword',
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5433',
  POSTGRES_DB: 'ypad_test',
  VALKEY_HOST: 'localhost',
  VALKEY_PORT: '6380',
  // valkey-test boots with `--requirepass testpassword`
  // (deploy/compose/compose.test.yml); an empty value fails every op with NOAUTH
  // and the health probe never turns green.
  VALKEY_PASSWORD: 'testpassword',
  VALKEY_DB: '0',
  DATABASE_URL: 'postgres://ypad:testpassword@localhost:5433/ypad_test',
  // A production build always asks Postgres for TLS; postgres-test has none.
  PGSSL: 'disable',
  // ioredis takes the password from the URL's userinfo segment; same
  // literal as VALKEY_PASSWORD.
  VALKEY_URL: 'redis://:testpassword@localhost:6380/0',
  NUXT_S3_ENDPOINT: 'http://localhost:8334',
  NUXT_S3_ACCESS_KEY: 'ypad-access-key',
  NUXT_S3_SECRET_KEY: 'ypad-secret-key',
  NUXT_S3_BUCKET: 'ypad',
  NUXT_MARKITDOWN_URL: 'http://localhost:8081',
  // MARKITDOWN_API_SECRET of markitdown-test (deploy/compose/compose.test.yml); without
  // it every import answers 401.
  NUXT_MARKITDOWN_API_SECRET: 'test-markitdown-api-secret-isolated',
  // renderer-test publishes :9000 on host :9101 (deploy/compose/compose.test.yml).
  // Without this override the renderer health probe targets the runtimeConfig
  // default (`http://localhost:9000`), health returns 503 and no flow runs.
  // Same value as tests/integration/setup/server.ts.
  NUXT_RENDERER_INTERNAL_URL: 'http://localhost:9101',
  // Same loopback host as the app (see NUXT_URL): the browser's sync
  // socket and the CSP connect-src name it, not plain `localhost`.
  NUXT_PUBLIC_SYNC_URL: 'ws://markoto.localhost:4002',
  NUXT_SYNC_INTERNAL_URL: 'http://localhost:4002',
  NUXT_JWT_SECRET: 'test-jwt-secret-isolated-from-dev-and-prod-stacks-64char',
  NUXT_INTERNAL_API_SECRET: 'test-internal-api-secret-isolated',
  NUXT_SESSION_PASSWORD: 'test-session-password-at-least-32-chars-isolated-x',
  // The test stack's `litellm-test` container. Upstream provider keys
  // (Mistral / Jina / BFL) are forwarded from the host in `main()`. Every
  // flow needs it so resolveBillingContext can lazily create the user's
  // virtual key; the budget-exhausted flow drives the real /key/* admin API.
  NUXT_LITELLM_URL: 'http://127.0.0.1:4100',
  NUXT_LITELLM_MASTER_KEY: 'sk-test-litellm-master',
  // LiteLLM's own database on postgres-test (deploy/compose/compose.test.yml);
  // the spend-log sweeps read it. Same values as tests/integration/setup.
  NUXT_LITELLM_DB_NAME: 'litellm_test',
  NUXT_LITELLM_DB_USER: 'litellm_test',
  NUXT_LITELLM_DB_PASSWORD: 'litellmtestpassword',
  NUXT_ENCRYPTION_KEY: 'test-encryption-key-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
  // Billing mode and the marketing site are set per pass, not here: main()
  // runs untagged flows against the hosted shape (billing off, paid plans
  // "coming soon", marketing off), `@billing` flows against a billing-on
  // server (their checkout UI only exists there) and `@marketing` flows
  // against a server with the marketing site on (its pages 404 elsewhere).
  // See PHASES below.
  // Legal surfaces ON (hosted shape): the onboarding gate, consent banner
  // and /legal/* flows document the hosted service.
  NUXT_LEGAL_SURFACES_ENABLED: 'true',
  // Anonymous gate follows the legal surfaces (on): flows tick the terms
  // box and the browser solves the real (test-difficulty) ALTCHA.
  NUXT_ALTCHA_HMAC_KEY: 'test-altcha-hmac-key-isolated-from-dev-and-prod-x',
  // Stripe talks to stripe-mock, as in tests/integration/setup/server.ts.
  NUXT_STRIPE_SECRET_KEY: 'sk_test_flows123',
  NUXT_STRIPE_WEBHOOK_SECRET: 'whsec_test_flows',
  NUXT_STRIPE_API_BASE: 'http://127.0.0.1:12111',
  // Stripe price catalogue for stripe-mock (no lookup keys) — same map as
  // tests/integration/setup/env.ts#TEST_STRIPE_PRICE_IDS.
  NUXT_STRIPE_PRICE_IDS: 'markoto_pro_month_eur=price_test_pro,markoto_pro_year_eur=price_test_pro_year,markoto_team_month_eur=price_test_team,markoto_team_year_eur=price_test_team_year,markoto_business_month_eur=price_test_business,markoto_business_year_eur=price_test_business_year,markoto_pro_month_chf=price_test_pro_chf,markoto_pro_year_chf=price_1PgafmB7WZ01zgkW6dKueIc5,markoto_team_month_chf=price_test_team_chf,markoto_team_year_chf=price_test_team_year_chf,markoto_business_month_chf=price_test_business_chf,markoto_business_year_chf=price_test_business_year_chf',
  // Skip the inactive-doc sweep: pointless on short-lived infra.
  NUXT_INACTIVE_DOC_TTL_DAYS: '0',
  // Expose `window.__DEBUG_ydoc` / `__DEBUG_ytext` from useDocument so
  // `read-only-share.spec.ts` can assert Y.Doc state directly (CM6 viewport
  // virtualisation makes .cm-content unreliable for long docs).
  NUXT_PUBLIC_EXPOSE_TEST_HANDLES: '1',
  // AI providers: instance defaults on the bundled LiteLLM aliases. Chat
  // runs on the hosted free-allowance model (Z.ai GLM-5.3 Flash on Mistral's
  // EU endpoint) inside the shared monthly pool
  // (NUXT_FREE_TIER_TOTAL_BUDGET_USD -> LiteLLM team), so live-AI flows
  // exercise the hosted default. The private-network opt-in lets the
  // `ai-provider-settings` flow save the fake OpenAI-compatible provider
  // (`fake-openai-test`) at the docker bridge address.
  NUXT_AI_DEFAULT_CHAT_MODEL: 'zai-glm-5-3-flash',
  NUXT_FREE_TIER_TOTAL_BUDGET_USD: '500',
  NUXT_AI_DEFAULT_IMAGE_MODEL: 'flux-2-pro',
  NUXT_AI_DEFAULT_TRANSCRIBE_MODEL: 'voxtral-mini-transcribe',
  NUXT_AI_BYOK_ALLOW_PRIVATE_URLS: 'true',
  // The `workspace-sso` flow's IdP is the mock OpenID provider on the test
  // network's private address.
  NUXT_SSO_ALLOW_PRIVATE_URLS: 'true',
  // Live dictation on the alias default needs the operator's Mistral key
  // in the APP process (the realtime WS is direct, not via LiteLLM) —
  // without it the dictation button is hidden. The flow stack swaps the
  // realtime client for the canned mock (NUXT_VOXTRAL_REALTIME_MOCK above),
  // so a placeholder is enough on the key-less PR gate; a real key from
  // the host env is kept when present.
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || 'flows-placeholder-mistral-key'
}

// The passes of one run. Same database + infra; only the app server
// restarts with another shape. `grep` narrows Playwright to one tag's
// flows; `selectEnv` tells playwright.config.ts which tags its
// grepInvert may let through (FLOWS_BILLING_ENABLED /
// FLOWS_MARKETING_ENABLED, both unset = only untagged flows).
//
// Every pass sets NUXT_MARKETING_SITE_ENABLED explicitly, so a value
// inherited from the shell can't turn the product tour on in the default
// pass (silentSetup clicks the plain hero's button).
//
// The marketing pass is the hosted shape (billing off, paid plans
// "coming soon", legal surfaces + anonymous gate as in FLOWS_ENV) with
// the marketing site on and a loopback NUXT_SITE_URL, so the pages'
// canonical / hreflang / JSON-LD links name the URL the browser loads.
// `*.localhost` is loopback, so TEST_MODE stays active.
type Phase = {
  name: string
  env: Record<string, string>
  selectEnv: { FLOWS_BILLING_ENABLED: string, FLOWS_MARKETING_ENABLED: string }
  grep: string[]
}
const HOSTED_BILLING = { NUXT_BILLING_ENABLED: 'false', NUXT_PLANS_COMING_SOON: 'true' }
const DEFAULT_PHASE: Phase = {
  name: 'default (hosted shape)',
  env: { ...HOSTED_BILLING, NUXT_MARKETING_SITE_ENABLED: 'false' },
  selectEnv: { FLOWS_BILLING_ENABLED: '', FLOWS_MARKETING_ENABLED: '' },
  grep: []
}
const BILLING_PHASE: Phase = {
  name: 'billing on (@billing flows)',
  env: { NUXT_BILLING_ENABLED: 'true', NUXT_PLANS_COMING_SOON: 'false', NUXT_MARKETING_SITE_ENABLED: 'false' },
  selectEnv: { FLOWS_BILLING_ENABLED: '1', FLOWS_MARKETING_ENABLED: '' },
  grep: ['--grep', '@billing']
}
const MARKETING_PHASE: Phase = {
  name: 'marketing site on (@marketing flows)',
  env: { ...HOSTED_BILLING, NUXT_MARKETING_SITE_ENABLED: 'true', NUXT_SITE_URL: NUXT_URL },
  selectEnv: { FLOWS_BILLING_ENABLED: '', FLOWS_MARKETING_ENABLED: '1' },
  grep: ['--grep', '@marketing']
}
const PHASES: readonly Phase[] = [DEFAULT_PHASE, BILLING_PHASE, MARKETING_PHASE]

let nuxtProc: Subprocess | null = null
let cleaningUp = false

async function shellOut(cmd: string[]): Promise<number> {
  // Explicit env: Bun.spawn doesn't reliably propagate `process.env`
  // mutations made after startup (PLAYWRIGHT_BASE_URL is set just before
  // Playwright runs). Without it Playwright falls back to localhost:3000
  // and starts its own webServer there.
  const proc = spawn({ cmd, env: process.env as Record<string, string>, stdout: 'inherit', stderr: 'inherit' })
  return await proc.exited
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) })
      // Only 200 counts as ready: /api/health queries `users`, which 500s
      // while `00-db-migrate` is still running.
      if (r.status === 200) return
    } catch { /* connection refused etc — keep polling */ }
    await Bun.sleep(500)
  }
  throw new Error(`timed out waiting for ${url} after ${timeoutMs}ms`)
}

async function stopNuxt() {
  const proc = nuxtProc
  if (!proc) return
  nuxtProc = null
  console.log('[flows-ephemeral] stopping Nuxt server')
  try {
    proc.kill('SIGTERM')
  } catch { /* already dead */ }
  const t = setTimeout(() => {
    try {
      proc.kill('SIGKILL')
    } catch { /* already dead */ }
  }, 5000)
  await proc.exited.catch(() => {})
  clearTimeout(t)
}

async function startNuxt(extraEnv: Record<string, string>) {
  console.log(`[flows-ephemeral] starting production server on :${NUXT_PORT}`)
  nuxtProc = spawn({
    cmd: ['bun', 'run', '.output/server/index.mjs'],
    env: { ...process.env, ...FLOWS_ENV, ...extraEnv },
    stdout: 'inherit',
    stderr: 'inherit'
  })
  console.log(`[flows-ephemeral] waiting for ${NUXT_URL} to come up`)
  await waitForHttp(`${NUXT_URL}/api/health`, 60_000)
}

async function cleanup() {
  if (cleaningUp) return
  cleaningUp = true
  await stopNuxt()
  console.log('[flows-ephemeral] tearing down docker stack')
  // NOTE: NO --remove-orphans here — that flag treats other compose
  // files in the same project namespace as orphans and removes them
  // (e.g. nuking dev containers). Down only stops what THIS profile
  // started; integration-test services + dev infra survive.
  await shellOut(['bash', TEST_COMPOSE, '--profile', COMPOSE_PROFILE, 'down', '-v'])
}

async function main() {
  await bootStack()
  await buildApp()
  // Steps 3–5, once per pass that has flows to run: spawn the production Nitro
  // server (preset 'bun' → .output/server/index.mjs runs under Bun),
  // wait for it, run Playwright with the caller's argv (e.g.
  // `--project=en-light-desktop`), stop the server.
  //
  // Serve-only mode (local debugging): keep the stack + app alive and skip
  // Playwright + teardown so you can iterate with `flows:test:against-running`
  // against http://markoto.localhost:3001. Ctrl-C to tear down. Not used by CI.
  if (process.env.FLOWS_SERVE_ONLY === '1') {
    await serveOnly()
    return
  }
  await runPasses(process.argv.slice(2))
}

async function bootStack() {
  // Step 1: docker stack. The renderer container navigates back to the app's
  // print page — point it at OUR port (the flow app serves on NUXT_PORT, not
  // the integration default of 3101), or every server-rendered-PDF flow fails
  // because the renderer can't reach the app.
  process.env.RENDERER_APP_URL = `http://host.docker.internal:${NUXT_PORT}`
  // Same story for sync-test: it posts activity-log rows back to the app.
  // The flow app serves on NUXT_PORT (3001). Set this EXPLICITLY (not just
  // relying on the compose default) so that when the CI job brought sync-test
  // up pointed at the integration port (3101), this `up` recreates it back on
  // our port — otherwise the inherited env would leave it on 3101 and every
  // activity-attribution flow would silently log to a dead port.
  process.env.SYNC_TEST_APP_URL = `http://host.docker.internal:${NUXT_PORT}`
  console.log('[flows-ephemeral] booting docker stack')
  const upCode = await shellOut(['bash', TEST_COMPOSE, '--profile', COMPOSE_PROFILE, 'up', '-d', '--wait'])
  if (upCode !== 0) {
    console.error('[flows-ephemeral] docker compose up failed')
    process.exit(upCode)
  }
}

async function buildApp() {
  // Step 2: production build. Skip with FLOWS_SKIP_BUILD=1 if you've
  // already got a fresh .output/ from a previous run AND haven't
  // touched app code (rare — most edits invalidate the bundle).
  // A test build (MARKOTO_TEST_BUILD=1): the flows sign in through
  // /api/_test/login, which production builds leave out.
  if (process.env.FLOWS_SKIP_BUILD === '1' && testRoutesInBuild('.output').length > 0) {
    console.log('[flows-ephemeral] FLOWS_SKIP_BUILD=1 — reusing existing .output/')
  } else {
    console.log('[flows-ephemeral] building production bundle (test build)')
    process.env.MARKOTO_TEST_BUILD = '1'
    const buildCode = await shellOut(['bun', 'run', 'build'])
    if (buildCode !== 0) {
      console.error('[flows-ephemeral] bun run build failed')
      process.exit(buildCode)
    }
  }
}

async function serveOnly() {
  // FLOWS_BILLING=on / FLOWS_MARKETING=on serve that pass's shape
  // instead (run `flows:test:against-running` with the matching
  // FLOWS_BILLING_ENABLED=1 / FLOWS_MARKETING_ENABLED=1 to select its flows).
  let phase = DEFAULT_PHASE
  if (process.env.FLOWS_BILLING === 'on') phase = BILLING_PHASE
  else if (process.env.FLOWS_MARKETING === 'on') phase = MARKETING_PHASE
  await startNuxt(phase.env)
  console.log(`[flows-ephemeral] FLOWS_SERVE_ONLY=1 — app up at ${NUXT_URL} (${phase.name}). Ctrl-C to tear down.`)
  await new Promise(() => {}) // wait forever; cleanup runs on SIGINT/SIGTERM
}

async function runPasses(args: string[]) {
  let exitCode = 0
  let testsRan = 0
  for (const phase of PHASES) {
    // Tells playwright.config.ts which tagged flows may be selected.
    Object.assign(process.env, phase.selectEnv)
    // A run filtered to specs of one kind (flows:test:changed, a path
    // argument) leaves the other passes empty: skip them without
    // restarting the app. All passes empty is an error (checked below).
    const listed = await countListedTests([...phase.grep, ...args])
    if (listed === 0) {
      console.log(`[flows-ephemeral] no flows for this pass — skipping ${phase.name}`)
      continue
    }
    testsRan += listed
    await startNuxt(phase.env)
    console.log(`[flows-ephemeral] running Playwright — ${phase.name} (${listed} tests)`)
    const code = await shellOut([
      'bunx', 'playwright', 'test',
      ...phase.grep,
      '--pass-with-no-tests',
      ...args
    ])
    if (code !== 0) exitCode = code
    await stopNuxt()
  }
  if (testsRan === 0) {
    console.error('[flows-ephemeral] no flow matched the given filters in any pass')
    exitCode = exitCode || 1
  }
  process.exitCode = exitCode
}

/** How many tests Playwright would run for these args (current env). */
async function countListedTests(args: string[]): Promise<number> {
  const proc = spawn({
    cmd: ['bunx', 'playwright', 'test', '--list', '--pass-with-no-tests', ...args],
    // Explicit env, as in shellOut: the pass's FLOWS_*_ENABLED were set
    // on process.env just before this call.
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'ignore'
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const m = /Total: (\d+) tests?/.exec(out)
  return m ? Number(m[1]) : 0
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
