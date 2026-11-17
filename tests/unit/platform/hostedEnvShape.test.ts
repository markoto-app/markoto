import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RECOMMENDED_SAAS_ALLOWED_BASE_URLS } from '../../../shared/ai/providers'
import { resolveTiersFromEnv } from '../../../shared/config/tiers'
import { bootProblems } from '../env/fixtures'

// The hosted SaaS shape is pure configuration: infra/render-env.sh renders
// the .env that the prod compose stack reads, for both deploy paths
// (deploy.yml and the Ansible role). This pins the defaults a staging/prod deploy
// gets when the GitHub Environment sets only the required secrets:
// billing off, plans "coming soon", legal surfaces on, BYOK limited to
// the known providers (the SSRF allowlist must match shared/ai/providers.ts),
// the free AI allowance (chat default = the GLM-5.3 Flash alias, $0.50 per
// user and $500 in total per month; image / transcription stay BYOK) and
// no OIDC login. infra/render-env-test.sh pins the renderer's mechanics.

const ROOT = resolve(__dirname, '../../..')

const REQUIRED = [
  'NUXT_SESSION_PASSWORD', 'NUXT_JWT_SECRET', 'NUXT_INTERNAL_API_SECRET', 'NUXT_ALTCHA_HMAC_KEY', 'NUXT_ENCRYPTION_KEY',
  'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'VALKEY_PASSWORD',
  'NUXT_S3_ENDPOINT', 'NUXT_S3_ACCESS_KEY', 'NUXT_S3_SECRET_KEY', 'NUXT_S3_BUCKET',
  'LITELLM_MASTER_KEY', 'LITELLM_SALT_KEY',
  'JINA_AI_API_KEY', 'STAAN_API_KEY', 'MISTRAL_API_KEY', 'BFL_API_KEY',
  'BACKUP_GPG_PASSPHRASE', 'DOMAIN', 'ACME_EMAIL', 'REGISTRY', 'IMAGE_TAG',
  'NUXT_MARKITDOWN_API_SECRET', 'NUXT_LEGAL_CONTROLLER_ADDRESS', 'NUXT_LEGAL_REPRESENTED_BY',
  'NUXT_PUBLISH_PAGES_HOST'
]

/** Sample value of a required var (hostnames must look like hostnames). */
function sample(name: string): string {
  return name === 'NUXT_PUBLISH_PAGES_HOST' ? 'pages.example.org' : `test-${name.toLowerCase()}`
}

function renderEnv(omit?: string) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
  for (const name of REQUIRED) if (name !== omit) env[name] = sample(name)
  return spawnSync('bash', [resolve(ROOT, 'infra/render-env.sh')], { env, encoding: 'utf8' })
}

function renderHostedEnv(): Map<string, string> {
  const out = renderEnv()
  expect(out.status, out.stderr).toBe(0)
  const vars = new Map<string, string>()
  for (const line of out.stdout.split('\n')) {
    const eq = line.indexOf('=')
    if (/^[A-Z][A-Z0-9_]*=/.test(line)) vars.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return vars
}

describe('hosted .env shape (infra/render-env.sh defaults)', () => {
  const vars = renderHostedEnv()

  it('runs free-only: billing off, paid plans "coming soon"', () => {
    expect(vars.get('NUXT_BILLING_ENABLED')).toBe('false')
    expect(vars.get('NUXT_PLANS_COMING_SOON')).toBe('true')
  })

  it('switches the legal surfaces on', () => {
    expect(vars.get('NUXT_LEGAL_SURFACES_ENABLED')).toBe('true')
  })

  it('gates anonymous use (terms + ALTCHA) and carries the ALTCHA key', () => {
    expect(vars.get('NUXT_ANON_GATE_ENABLED')).toBe('true')
    expect(vars.get('NUXT_ALTCHA_HMAC_KEY')).toBe('test-nuxt_altcha_hmac_key')
  })

  it.each(['NUXT_ALTCHA_HMAC_KEY', 'NUXT_MARKITDOWN_API_SECRET', 'NUXT_LEGAL_CONTROLLER_ADDRESS', 'NUXT_LEGAL_REPRESENTED_BY', 'NUXT_PUBLISH_PAGES_HOST'])(
    'refuses to render without %s',
    (name) => {
      const out = renderEnv(name)
      expect(out.status).not.toBe(0)
      expect(out.stderr).toContain(name)
    }
  )

  it('serves published pages from their own host, a plain hostname only', () => {
    expect(vars.get('NUXT_PUBLISH_PAGES_HOST')).toBe('pages.example.org')
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
    for (const name of REQUIRED) env[name] = sample(name)
    env.NUXT_PUBLISH_PAGES_HOST = 'pages.example.org`) || Host(`evil.example'
    const out = spawnSync('bash', [resolve(ROOT, 'infra/render-env.sh')], { env, encoding: 'utf8' })
    expect(out.status).not.toBe(0)
    expect(out.stderr).toContain('NUXT_PUBLISH_PAGES_HOST must be a plain hostname')
  })

  it('carries the markitdown secret', () => {
    expect(vars.get('NUXT_MARKITDOWN_API_SECRET')).toBe('test-nuxt_markitdown_api_secret')
  })

  it('carries an operator identity the legal-surfaces boot check accepts', () => {
    const env = Object.fromEntries([...vars].filter(([k]) => k.startsWith('NUXT_LEGAL_')))
    // Only the operator-identity problems count here; the other hosted-shape
    // rules (allowlist, pages host, ALTCHA) need values this slice leaves out.
    expect(bootProblems(env).filter(p => p.startsWith('NUXT_LEGAL_'))).toEqual([])
  })

  it('limits BYOK base URLs to the SaaS provider allowlist, no private URLs', () => {
    expect(vars.get('NUXT_AI_BYOK_ALLOWED_BASE_URLS')).toBe(RECOMMENDED_SAAS_ALLOWED_BASE_URLS.join(','))
    expect(vars.get('NUXT_AI_BYOK_ALLOW_PRIVATE_URLS')).toBe('false')
  })

  it('gives signed-in users the free AI allowance: chat on the platform-paid GLM-5.3 Flash alias', () => {
    expect(vars.get('NUXT_AI_DEFAULT_CHAT_MODEL')).toBe('zai-glm-5-3-flash')
    expect(vars.get('NUXT_AI_DEFAULT_CHAT_VISION')).toBe('true')
    // An alias, not an endpoint: platform-paid through LiteLLM, never clientside credentials.
    expect(vars.get('NUXT_AI_DEFAULT_CHAT_BASE_URL')).toBe('')
    expect(vars.get('NUXT_AI_DEFAULT_CHAT_API_KEY')).toBe('')
  })

  it('caps it at $0.50 per user and $500 in total per month', () => {
    expect(vars.get('TIER_FREE_LITELLM_BUDGET_USD')).toBe('0.5')
    expect(vars.get('NUXT_FREE_TIER_TOTAL_BUDGET_USD')).toBe('500')
  })

  it('narrows the free tier\'s plan limits (plan entitlements)', () => {
    expect(vars.get('TIER_FREE_MEMBERS_PER_WORKSPACE')).toBe('3')
    expect(vars.get('TIER_FREE_HISTORY_DAYS')).toBe('30')
    expect(vars.get('TIER_FREE_SAVED_THEMES')).toBe('3')
    expect(vars.get('TIER_FREE_IMPORT_MAX_BYTES')).toBe(String(10 * 1024 * 1024))
    expect(vars.get('TIER_FREE_WEB_TOOLS_PER_DAY')).toBe('20')
    expect(vars.get('TIER_FREE_MCP_TOOL_CALLS_PER_DAY')).toBe('100')
    expect(vars.get('TIER_FREE_FEATURE_CUSTOM_CSS')).toBe('false')
    expect(vars.get('TIER_FREE_FEATURE_MCP_WRITE')).toBe('false')
    expect(vars.get('TIER_FREE_FEATURE_AI_IMAGE')).toBe('false')
    expect(vars.get('TIER_FREE_FEATURE_AI_VOICE')).toBe('false')
    expect(vars.get('TIER_FREE_FEATURE_AI_STRONG_MODEL')).toBe('false')
  })

  it('every hosted free-tier limit parses into the resolved tier map', () => {
    const env = Object.fromEntries([...vars].filter(([k]) => k.startsWith('TIER_')))
    const free = resolveTiersFromEnv(env).free
    expect(free).toMatchObject({
      membersPerWorkspace: 3,
      historyDays: 30,
      savedThemes: 3,
      importMaxBytes: 10 * 1024 * 1024,
      webToolsPerDay: 20,
      mcpToolCallsPerDay: 100,
      customCss: false,
      mcpWrite: false
    })
  })

  it('the chat default is a deployment in deploy/config/litellm/config.yaml', () => {
    const config = readFileSync(resolve(ROOT, 'deploy/config/litellm/config.yaml'), 'utf8')
    expect(config).toContain(`- model_name: ${vars.get('NUXT_AI_DEFAULT_CHAT_MODEL')}\n`)
  })

  it('runs the worker on the markoto-worker aliases of deploy/config/litellm/config.yaml', () => {
    expect(vars.get('NUXT_AI_DEFAULT_WORKER_MODEL')).toBe('markoto-worker')
    expect(vars.get('NUXT_AI_DEFAULT_WORKER_STRONG_MODEL')).toBe('markoto-worker-strong')
    const config = readFileSync(resolve(ROOT, 'deploy/config/litellm/config.yaml'), 'utf8')
    for (const k of ['NUXT_AI_DEFAULT_WORKER_MODEL', 'NUXT_AI_DEFAULT_WORKER_STRONG_MODEL']) {
      expect(config, k).toContain(`- model_name: ${vars.get(k)}\n`)
    }
    // Aliases only: platform-paid through LiteLLM, never an operator endpoint.
    expect(vars.has('NUXT_AI_DEFAULT_WORKER_BASE_URL')).toBe(false)
    expect(vars.has('NUXT_AI_DEFAULT_WORKER_API_KEY')).toBe(false)
  })

  it('image / voice / strong-model defaults are platform aliases, locked for the free tier', () => {
    expect(vars.get('NUXT_AI_DEFAULT_IMAGE_MODEL')).toBe('flux-3-image-klein')
    expect(vars.get('NUXT_AI_DEFAULT_TRANSCRIBE_MODEL')).toBe('voxtral-mini-transcribe')
    expect(vars.get('NUXT_AI_DEFAULT_CHAT_STRONG_MODEL')).toBe('mistral-small-2603')
    // Aliases only: never an operator endpoint + key for these.
    for (const k of ['IMAGE', 'TRANSCRIBE']) {
      expect(vars.get(`NUXT_AI_DEFAULT_${k}_BASE_URL`), k).toBe('')
      expect(vars.get(`NUXT_AI_DEFAULT_${k}_API_KEY`), k).toBe('')
    }
    // With billing off everyone is on the free tier: nobody gets them
    // on markoto.app without their own key.
    expect(vars.get('TIER_FREE_FEATURE_AI_IMAGE')).toBe('false')
    expect(vars.get('TIER_FREE_FEATURE_AI_VOICE')).toBe('false')
  })

  it('each free-allowance default can be overridden by an Environment variable', () => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
    for (const name of REQUIRED) env[name] = sample(name)
    Object.assign(env, { NUXT_AI_DEFAULT_CHAT_MODEL: 'mistral-small-2603', TIER_FREE_LITELLM_BUDGET_USD: '2', NUXT_FREE_TIER_TOTAL_BUDGET_USD: '0' })
    const out = spawnSync('bash', [resolve(ROOT, 'infra/render-env.sh')], { env, encoding: 'utf8' })
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toContain('\nNUXT_AI_DEFAULT_CHAT_MODEL=mistral-small-2603\n')
    expect(out.stdout).toContain('\nTIER_FREE_LITELLM_BUDGET_USD=2\n')
    expect(out.stdout).toContain('\nNUXT_FREE_TIER_TOTAL_BUDGET_USD=0\n')
  })

  it('keeps the hosted embeddings (empty overrides = Jina default in compose)', () => {
    expect(vars.get('NUXT_LITELLM_EMBEDDINGS_MODEL')).toBe('')
    expect(vars.get('NUXT_LITELLM_EMBEDDINGS_DIMS')).toBe('')
  })

  it('does not enable OIDC login', () => {
    expect([...vars.keys()].filter(k => k.includes('OIDC'))).toEqual([])
  })
})

describe('the Ansible path', () => {
  const role = readFileSync(resolve(ROOT, 'infra/roles/markoto/tasks/main.yml'), 'utf8')

  it('renders .env through render-env.sh, so it gets the same hosted defaults', () => {
    expect(role).toContain('infra/render-env.sh --keys')
    expect(role).toMatch(/cmd: bash \{\{ markoto_repo_root \}\}\/infra\/render-env\.sh\n/)
    expect(role).not.toMatch(/ansible\.builtin\.template/)
  })
})

// Every variable the prod stack interpolates must be renderable from the
// deploy, or setting it in GitHub silently has no effect.
describe('render-env.sh covers every variable the prod compose stack reads', () => {
  // LITELLM_CONFIG_HASH is exported by the deploy step itself;
  // NUXT_PRODUCT_TOUR_ENABLED is a one-release alias the hosted stack never sets.
  // CONTAINER_SOCKET: exported on the host by markoto-compose (the markoto
  // user's Podman socket), like LITELLM_CONFIG_HASH.
  const NOT_RENDERED = new Set(['LITELLM_CONFIG_HASH', 'NUXT_PRODUCT_TOUR_ENABLED', 'CONTAINER_SOCKET'])

  it('emits each ${VAR} of deploy/compose/compose.prod.yml + deploy/compose/compose.base.yml', () => {
    const rendered = renderHostedEnv()
    const compose = ['deploy/compose/compose.prod.yml', 'deploy/compose/compose.base.yml']
      .map(f => readFileSync(resolve(ROOT, f), 'utf8'))
      .join('\n')
      .split('\n')
      .filter(line => !line.trim().startsWith('#'))
      .join('\n')
    const used = new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map(m => m[1]!))
    const missing = [...used].filter(name => !rendered.has(name) && !NOT_RENDERED.has(name)).sort()
    expect(missing).toEqual([])
  })
})

// Regression (fail-open allowlist): prod compose passed `${VAR:-}`, so a
// .env without the line meant "any public URL" on the hosted service.
describe('compose files never default the hosted BYOK allowlist to empty', () => {
  it('prod requires it', () => {
    const prod = readFileSync(resolve(ROOT, 'deploy/compose/compose.prod.yml'), 'utf8')
    expect(prod).toMatch(/NUXT_AI_BYOK_ALLOWED_BASE_URLS=\$\{NUXT_AI_BYOK_ALLOWED_BASE_URLS:\?/)
  })

  it('local (hosted shape: legal surfaces on) defaults to the SaaS list', () => {
    const local = readFileSync(resolve(ROOT, 'deploy/compose/compose.local.yml'), 'utf8')
    const m = /NUXT_AI_BYOK_ALLOWED_BASE_URLS=\$\{NUXT_AI_BYOK_ALLOWED_BASE_URLS:-([^}]*)\}/.exec(local)
    expect(m?.[1]).toBe(RECOMMENDED_SAAS_ALLOWED_BASE_URLS.join(','))
  })
})

const HOSTED = {
  NUXT_LEGAL_SURFACES_ENABLED: 'true',
  NUXT_LEGAL_CONTROLLER_ADDRESS: '1 Example Street, 8000 Zurich',
  NUXT_LEGAL_REPRESENTED_BY: 'Jane Doe',
  NUXT_PUBLISH_PAGES_HOST: 'pages.example.org',
  NUXT_PUBLISH_TRAEFIK_TOKEN: 't'.repeat(32),
  NUXT_SITE_URL: 'https://docs.example.org',
  NUXT_ALTCHA_HMAC_KEY: 'k'.repeat(32)
}

describe('boot check of the BYOK URL policy', () => {
  it('regression: the hosted shape with an empty allowlist refuses to boot', () => {
    expect(bootProblems(HOSTED).join(' ')).toMatch(/NUXT_AI_BYOK_ALLOWED_BASE_URLS is empty/)
    expect(bootProblems({ ...HOSTED, NUXT_AI_BYOK_ALLOWED_BASE_URLS: ' , ' })).toHaveLength(1)
  })

  it('the hosted shape with the SaaS list boots', () => {
    expect(bootProblems({ ...HOSTED, NUXT_AI_BYOK_ALLOWED_BASE_URLS: RECOMMENDED_SAAS_ALLOWED_BASE_URLS.join(',') })).toEqual([])
  })

  it('self-host may leave it empty (free-form URLs)', () => {
    expect(bootProblems({})).toEqual([])
  })

  it('reports entries that are not absolute http(s) URLs in any shape', () => {
    expect(bootProblems({ NUXT_AI_BYOK_ALLOWED_BASE_URLS: 'https://api.mistral.ai/v1,api.openai.com/v1' }))
      .toEqual(['NUXT_AI_BYOK_ALLOWED_BASE_URLS: entry 2: expected an absolute http/https URL'])
  })
})
