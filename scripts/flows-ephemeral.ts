#!/usr/bin/env bun
import { spawn, type Subprocess } from 'bun'

// Orchestrator for `bun run flows:test`. Hermetic, end-to-end.
//
// 1. Bring up docker-compose.flows.yml (waits for healthchecks).
// 2. Run `bun run build` (production Nitro output to .output/).
// 3. Spawn `bun run .output/server/index.mjs` against the ephemeral
//    infra on port 3001.
// 4. Wait for /api/health to respond.
// 5. Run Playwright against http://markoto.localhost:3001.
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
// Runs `docker compose -f docker-compose.test.yml` (+ the Podman overlay on
// Podman, docs/CONTAINER-ENGINES.md).
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

// Env vars the Nuxt server needs to talk to the test infra. Mirrors
// .env but with shifted ports (5433/6380/8334/4002/8081 — see compose
// header) + isolated secrets that match what sync-test was built with.
//
// Phase 5 AI integration: AI flows (`tests/e2e/flows/ai-*.spec.ts`)
// drive the prompt bar / @ai mention against LiteLLM → Mistral to
// produce realistic screenshots. TEST_MODE=1 enables the
// `/api/_test/login` shim. LiteLLM master key + URL come from
// docker-compose.test.yml's litellm-test container.
const FLOWS_ENV: Record<string, string> = {
  PORT: String(NUXT_PORT),
  // TEST_MODE flips on /api/_test/login (so the flow fixture can seal a
  // session cookie without going through OAuth) AND short-circuits
  // billing's INSERT to ai_usage_period (so repeated flow runs don't
  // accumulate counter rows the cleanup volume reset would have to
  // discard). It does NOT bypass the LLM upstream — every AI call
  // still hits the live LiteLLM proxy.
  TEST_MODE: '1',
  // Swap Voxtral Realtime (the live STT path) for the canned-fake
  // SpeechClient (`server/utils/agentic/dictateSpeechClient.ts`).
  // voice-dictate.spec.ts depends on this — without it, the live STT
  // API receives the synthetic 16 kHz tone and returns nothing
  // recognisable, the dictation session times out, and the flow fails.
  NUXT_VOXTRAL_REALTIME_MOCK: '1',
  // Atomic Postgres parts — `postgresUrlFromEnv` reads these. Without
  // them, the Nitro subprocess inherits the parent shell's .env-loaded
  // dev vars and migrates the DEV database. (Same lesson as the
  // integration server.ts setup.)
  POSTGRES_USER: 'ypad',
  POSTGRES_PASSWORD: 'testpassword',
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5433',
  POSTGRES_DB: 'ypad_test',
  VALKEY_HOST: 'localhost',
  VALKEY_PORT: '6380',
  // valkey-test boots with `--requirepass testpassword` (see
  // docker-compose.test.yml). The hardcoded literal must match —
  // an empty string here makes the prod-build subprocess fail every
  // Valkey op with NOAUTH, which Nitro turns into a stuck health
  // probe and the orchestrator times out before any spec runs.
  VALKEY_PASSWORD: 'testpassword',
  VALKEY_DB: '0',
  DATABASE_URL: 'postgres://ypad:testpassword@localhost:5433/ypad_test',
  // VALKEY_URL needs the password embedded. ioredis honours the
  // userinfo segment of the URL; without it, the Redis client
  // skips AUTH and the server rejects every command. Same literal
  // as VALKEY_PASSWORD above.
  VALKEY_URL: 'redis://:testpassword@localhost:6380/0',
  NUXT_S3_ENDPOINT: 'http://localhost:8334',
  NUXT_S3_ACCESS_KEY: 'ypad-access-key',
  NUXT_S3_SECRET_KEY: 'ypad-secret-key',
  NUXT_S3_BUCKET: 'ypad',
  NUXT_MARKITDOWN_URL: 'http://localhost:8081',
  // MARKITDOWN_API_SECRET of markitdown-test (docker-compose.test.yml); without
  // it every import answers 401.
  NUXT_MARKITDOWN_API_SECRET: 'test-markitdown-api-secret-isolated',
  // renderer-test publishes :9000 on host :9101 (docker-compose.test.yml).
  // Without this override the prod build falls back to the runtimeConfig
  // default (`http://localhost:9000`), so the /api/health renderer probe is
  // `down` → health returns 503 → the health-wait below times out and NO flow
  // runs. (Locally this hid behind a stray dev renderer squatting on :9000.)
  // Same value the integration harness uses — see tests/integration/setup/server.ts.
  NUXT_RENDERER_INTERNAL_URL: 'http://localhost:9101',
  // Same loopback host as the app (see NUXT_URL): the browser's sync
  // socket and the CSP connect-src name it, not plain `localhost`.
  NUXT_PUBLIC_SYNC_URL: 'ws://markoto.localhost:4002',
  NUXT_SYNC_INTERNAL_URL: 'http://localhost:4002',
  NUXT_JWT_SECRET: 'test-jwt-secret-isolated-from-dev-and-prod-stacks-64char',
  NUXT_INTERNAL_API_SECRET: 'test-internal-api-secret-isolated',
  NUXT_SESSION_PASSWORD: 'test-session-password-at-least-32-chars-isolated-x',
  // LiteLLM proxy — the test stack's `litellm-test` container (added
  // alongside the integration suite). Required for AI flows; forwarded
  // upstream provider keys (Mistral / Jina / BFL) come from the host
  // at process start (see `main()` below). Phase 7: the
  // budget-exhausted flow drives the real /key/* admin surface to
  // drain a user's virtual key. Other flows don't currently exercise
  // model calls but the wire-up is required so resolveBillingContext
  // can lazy-create the user key without 500-ing.
  NUXT_LITELLM_URL: 'http://127.0.0.1:4100',
  NUXT_LITELLM_MASTER_KEY: 'sk-test-litellm-master',
  LITELLM_SALT_KEY: 'sk-test-litellm-salt-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
  // (TEST_MODE is set above, near the top of this object.)
  // Billing mode and the marketing site are NOT set here — main() runs
  // the suite in three passes (see PHASES below): every untagged flow
  // against the hosted shape (billing off, paid plans "coming soon",
  // marketing site off), so the docs show what markoto.app users
  // actually see; then only the `@billing`-tagged flows (upgrade-to-pro,
  // pricing-tour, ai-sponsoring, ai-budget-exhausted) against a
  // billing-ON server, because the checkout / plan / sponsorship UI they
  // drive only exists there; then only the `@marketing`-tagged flows
  // against a server with the marketing site on (its pages 404 elsewhere).
  // Legal surfaces ON (hosted shape): the onboarding gate, consent banner
  // and /legal/* flows document the hosted service.
  NUXT_LEGAL_SURFACES_ENABLED: 'true',
  // Anonymous gate follows the legal surfaces (on): flows tick the terms
  // box and the browser solves the real (test-difficulty) ALTCHA.
  NUXT_ALTCHA_HMAC_KEY: 'test-altcha-hmac-key-isolated-from-dev-and-prod-x',
  // Stripe: talks to stripe-mock. Aligns with the integration-test
  // setup (see tests/integration/setup/server.ts).
  NUXT_STRIPE_SECRET_KEY: 'sk_test_flows123',
  NUXT_STRIPE_WEBHOOK_SECRET: 'whsec_test_flows',
  NUXT_STRIPE_API_BASE: 'http://127.0.0.1:12111',
  // Stripe price catalogue for stripe-mock (no lookup keys) — same map as
  // tests/integration/setup/env.ts#TEST_STRIPE_PRICE_IDS.
  NUXT_STRIPE_PRICE_IDS: 'markoto_pro_month_eur=price_test_pro,markoto_pro_year_eur=price_test_pro_year,markoto_team_month_eur=price_test_team,markoto_team_year_eur=price_test_team_year,markoto_business_month_eur=price_test_business,markoto_business_year_eur=price_test_business_year,markoto_pro_month_chf=price_test_pro_chf,markoto_pro_year_chf=price_1PgafmB7WZ01zgkW6dKueIc5,markoto_team_month_chf=price_test_team_chf,markoto_team_year_chf=price_test_team_year_chf,markoto_business_month_chf=price_test_business_chf,markoto_business_year_chf=price_test_business_year_chf',
  // Skip the inactive-doc sweep — short-lived test infra doesn't
  // benefit and the TTL math complains on a fresh DB.
  NUXT_INACTIVE_DOC_TTL_DAYS: '0',
  // Expose `window.__DEBUG_ydoc` / `__DEBUG_ytext` from useDocument.
  // Read by `read-only-share.spec.ts` to assert Y.Doc state directly
  // (CM6 viewport virtualisation makes .cm-content unreliable for
  // long docs). Production builds default to false; only this test
  // stack flips it on.
  NUXT_PUBLIC_EXPOSE_TEST_HANDLES: '1',
  // AI providers (WP4, bring your own key). The flow stack is shaped like
  // a self-hosted instance whose operator configured the bundled LiteLLM
  // model aliases as instance defaults — so the live-AI flows keep
  // running on Mistral / BFL / Voxtral exactly as before BYOK. The
  // private-network opt-in lets the `ai-provider-settings` flow save the
  // fake OpenAI-compatible provider (docker-compose.test.yml
  // `fake-openai-test`) at the docker bridge address.
  // Chat runs on the hosted free-allowance model (Z.ai GLM-5.3 Flash on
  // Mistral's EU endpoint) inside the same shared monthly pool the hosted
  // SaaS uses (NUXT_FREE_TIER_TOTAL_BUDGET_USD → LiteLLM team), so the
  // live-AI flows exercise the hosted default. Image / transcription keep
  // the bundled aliases so those flows still run.
  NUXT_AI_DEFAULT_CHAT_MODEL: 'zai-glm-5-3-flash',
  NUXT_FREE_TIER_TOTAL_BUDGET_USD: '500',
  NUXT_AI_DEFAULT_IMAGE_MODEL: 'flux-2-pro',
  NUXT_AI_DEFAULT_TRANSCRIBE_MODEL: 'voxtral-mini-transcribe',
  NUXT_AI_BYOK_ALLOW_PRIVATE_URLS: 'true',
  // Per-workspace single sign-on (WP14): the `workspace-sso` flow's IdP is
  // the mock OpenID provider on the test network's private address.
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
      // STRICT: only 200 counts as ready. The previous "any 5xx is OK"
      // logic raced migrations — /api/health queries the `users`
      // table, which 500s while `00-db-migrate` is still running, and
      // we'd start Playwright against a DB without schema. Now we
      // wait until the health probe + DB query succeed end-to-end.
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

  // Step 2: production build. Skip with FLOWS_SKIP_BUILD=1 if you've
  // already got a fresh .output/ from a previous run AND haven't
  // touched app code (rare — most edits invalidate the bundle).
  if (process.env.FLOWS_SKIP_BUILD === '1') {
    console.log('[flows-ephemeral] FLOWS_SKIP_BUILD=1 — reusing existing .output/')
  } else {
    console.log('[flows-ephemeral] building production bundle')
    const buildCode = await shellOut(['bun', 'run', 'build'])
    if (buildCode !== 0) {
      console.error('[flows-ephemeral] bun run build failed')
      process.exit(buildCode)
    }
  }

  // Steps 3–5, once per pass that has flows to run: spawn the production Nitro
  // server (preset 'bun' → .output/server/index.mjs runs under Bun),
  // wait for it, run Playwright with the caller's argv (e.g.
  // `--project=en-light-desktop`), stop the server.
  //
  // Serve-only mode (local debugging): keep the stack + app alive and skip
  // Playwright + teardown so you can iterate with `flows:test:against-running`
  // against http://markoto.localhost:3001. Ctrl-C to tear down. Not used by CI.
  if (process.env.FLOWS_SERVE_ONLY === '1') {
    // FLOWS_BILLING=on / FLOWS_MARKETING=on serve that pass's shape
    // instead (run `flows:test:against-running` with the matching
    // FLOWS_BILLING_ENABLED=1 / FLOWS_MARKETING_ENABLED=1 to select its flows).
    let phase = DEFAULT_PHASE
    if (process.env.FLOWS_BILLING === 'on') phase = BILLING_PHASE
    else if (process.env.FLOWS_MARKETING === 'on') phase = MARKETING_PHASE
    await startNuxt(phase.env)
    console.log(`[flows-ephemeral] FLOWS_SERVE_ONLY=1 — app up at ${NUXT_URL} (${phase.name}). Ctrl-C to tear down.`)
    await new Promise(() => {}) // wait forever; cleanup runs on SIGINT/SIGTERM
    return
  }

  let exitCode = 0
  let testsRan = 0
  const args = process.argv.slice(2)
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
