import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RECOMMENDED_SAAS_ALLOWED_BASE_URLS } from '../../shared/ai/providers'
import { byokUrlPolicyErrors } from '../../server/utils/aiProviders/config'

// The hosted SaaS shape is pure configuration: infra/render-env.sh (CI
// deploys) and infra/templates/env.j2 (Ansible) render the .env that the
// prod compose stack reads. This pins the defaults a staging/prod deploy
// gets when the GitHub Environment sets only the required secrets:
// billing off, plans "coming soon", legal surfaces on, BYOK limited to
// the known providers (the SSRF allowlist must match shared/ai/providers.ts),
// no instance AI defaults (chat/image/transcription are BYOK on the SaaS)
// and no OIDC login. infra/render-env-parity-test.sh separately proves the
// two renderers agree for a given value set.

const ROOT = resolve(__dirname, '../..')

const REQUIRED = [
  'NUXT_SESSION_PASSWORD', 'NUXT_JWT_SECRET', 'NUXT_INTERNAL_API_SECRET',
  'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'VALKEY_PASSWORD',
  'NUXT_S3_ENDPOINT', 'NUXT_S3_ACCESS_KEY', 'NUXT_S3_SECRET_KEY', 'NUXT_S3_BUCKET',
  'LITELLM_MASTER_KEY', 'LITELLM_SALT_KEY',
  'JINA_AI_API_KEY', 'STAAN_API_KEY', 'MISTRAL_API_KEY', 'BFL_API_KEY',
  'BACKUP_GPG_PASSPHRASE', 'DOMAIN', 'ACME_EMAIL', 'REGISTRY', 'IMAGE_TAG'
]

function renderHostedEnv(): Map<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
  for (const name of REQUIRED) env[name] = `test-${name.toLowerCase()}`
  const out = spawnSync('bash', [resolve(ROOT, 'infra/render-env.sh')], { env, encoding: 'utf8' })
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

  it('limits BYOK base URLs to the SaaS provider allowlist, no private URLs', () => {
    expect(vars.get('NUXT_AI_BYOK_ALLOWED_BASE_URLS')).toBe(RECOMMENDED_SAAS_ALLOWED_BASE_URLS.join(','))
    expect(vars.get('NUXT_AI_BYOK_ALLOW_PRIVATE_URLS')).toBe('false')
  })

  it('sets no instance AI defaults (chat, image and transcription are BYOK)', () => {
    const defaults = [...vars].filter(([k]) => k.startsWith('NUXT_AI_DEFAULT_'))
    expect(defaults.length).toBeGreaterThan(0)
    for (const [k, v] of defaults) expect(v, k).toBe('')
  })

  it('keeps the hosted embeddings (empty overrides = Jina default in compose)', () => {
    expect(vars.get('NUXT_LITELLM_EMBEDDINGS_MODEL')).toBe('')
    expect(vars.get('NUXT_LITELLM_EMBEDDINGS_DIMS')).toBe('')
  })

  it('does not enable OIDC login', () => {
    expect([...vars.keys()].filter(k => k.includes('OIDC'))).toEqual([])
  })
})

describe('Ansible env.j2 hosted defaults', () => {
  const template = readFileSync(resolve(ROOT, 'infra/templates/env.j2'), 'utf8')

  it('uses the same BYOK allowlist default as shared/ai/providers.ts', () => {
    const m = /NUXT_AI_BYOK_ALLOWED_BASE_URLS=\{\{ nuxt_ai_byok_allowed_base_urls \| default\('([^']*)'\) \}\}/.exec(template)
    expect(m?.[1]).toBe(RECOMMENDED_SAAS_ALLOWED_BASE_URLS.join(','))
  })
})

// Regression (fail-open allowlist): prod compose passed `${VAR:-}`, so a
// .env without the line meant "any public URL" on the hosted service.
describe('compose files never default the hosted BYOK allowlist to empty', () => {
  it('prod requires it', () => {
    const prod = readFileSync(resolve(ROOT, 'docker-compose.prod.yml'), 'utf8')
    expect(prod).toMatch(/NUXT_AI_BYOK_ALLOWED_BASE_URLS=\$\{NUXT_AI_BYOK_ALLOWED_BASE_URLS:\?/)
  })

  it('local (hosted shape: legal surfaces on) defaults to the SaaS list', () => {
    const local = readFileSync(resolve(ROOT, 'docker-compose.local.yml'), 'utf8')
    const m = /NUXT_AI_BYOK_ALLOWED_BASE_URLS=\$\{NUXT_AI_BYOK_ALLOWED_BASE_URLS:-([^}]*)\}/.exec(local)
    expect(m?.[1]).toBe(RECOMMENDED_SAAS_ALLOWED_BASE_URLS.join(','))
  })
})

describe('boot check of the BYOK URL policy', () => {
  it('regression: the hosted shape with an empty allowlist refuses to boot', () => {
    expect(byokUrlPolicyErrors({}, true).join(' ')).toMatch(/NUXT_AI_BYOK_ALLOWED_BASE_URLS is empty/)
    expect(byokUrlPolicyErrors({ NUXT_AI_BYOK_ALLOWED_BASE_URLS: ' , ' }, true)).toHaveLength(1)
  })

  it('the hosted shape with the SaaS list boots', () => {
    expect(byokUrlPolicyErrors({ NUXT_AI_BYOK_ALLOWED_BASE_URLS: RECOMMENDED_SAAS_ALLOWED_BASE_URLS.join(',') }, true)).toEqual([])
  })

  it('self-host may leave it empty (free-form URLs)', () => {
    expect(byokUrlPolicyErrors({}, false)).toEqual([])
  })

  it('reports entries that are not absolute http(s) URLs in any shape', () => {
    const errors = byokUrlPolicyErrors({ NUXT_AI_BYOK_ALLOWED_BASE_URLS: 'https://api.mistral.ai/v1,api.openai.com/v1' }, false)
    expect(errors.join(' ')).toContain('"api.openai.com/v1"')
  })

  it('a list with only invalid entries counts as empty on the hosted shape', () => {
    expect(byokUrlPolicyErrors({ NUXT_AI_BYOK_ALLOWED_BASE_URLS: 'not-a-url' }, true)).toHaveLength(2)
  })
})
