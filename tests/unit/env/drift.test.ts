import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { registeredVars } from '../../../shared/env/registry'
import { nameFor, VALIDATED_SERVICES, type AnyVar, type Scope, type ValidatedService } from '../../../shared/env/define'

// The registry (shared/env) says which process reads each variable and
// whether the compose files hand it over. These checks hold the deploy
// files to that, in both directions: a variable compose passes that no
// process reads, a variable a process reads that no stack can pass, a
// value a deploy path writes that nothing uses.

const ROOT = resolve(import.meta.dirname, '../../..')
const read = (file: string): string => readFileSync(resolve(ROOT, file), 'utf8')

const VARS = registeredVars().map(v => v.spec)
const KNOWN = new Set(VARS.flatMap(spec => [spec.name, ...Object.values(spec.aliases ?? {}), ...(spec.deprecatedNames ?? [])]))

/** Keys of `services.<service>.environment` of the given compose files (later files win, as `include:` does). */
function composeEnv(files: readonly string[], service: string): Set<string> {
  const keys = new Set<string>()
  for (const file of files) {
    const env = (parse(read(file)) as { services?: Record<string, { environment?: string[] | Record<string, unknown> }> })
      .services?.[service]?.environment
    if (!env) continue
    for (const key of Array.isArray(env) ? env.map(e => e.split('=')[0]!) : Object.keys(env)) keys.add(key)
  }
  return keys
}

/** `${VAR}` interpolations of compose files (comments skipped); value = has a `:-` / `-` default. */
function interpolations(files: readonly string[]): Map<string, boolean> {
  const out = new Map<string, boolean>()
  for (const file of files) {
    const text = read(file).split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
    for (const m of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)(:?[-?])?/g)) {
      out.set(m[1]!, (out.get(m[1]!) ?? false) || (m[2]?.includes('-') ?? false))
    }
  }
  return out
}

/** `NAME=` assignments written by a deploy path. */
function assignments(file: string): Set<string> {
  return new Set([...read(file).matchAll(/^\s*([A-Z][A-Z0-9_]{2,})=/gm)].map(m => m[1]!))
}

const STACKS: Array<{ name: string, files: readonly string[], scopes: readonly Scope[] }> = [
  { name: 'hosted (prod)', files: ['deploy/compose/compose.base.yml', 'deploy/compose/compose.prod.yml'], scopes: ['both', 'hosted'] },
  { name: 'self-host', files: ['deploy/compose/compose.base.yml', 'deploy/compose/compose.selfhost.yml'], scopes: ['both', 'self-host'] }
]

const readBy = (spec: AnyVar, service: ValidatedService): boolean => spec.services.includes(service)

describe('compose ↔ registry', () => {
  for (const stack of STACKS) {
    for (const service of VALIDATED_SERVICES) {
      const passed = composeEnv(stack.files, service)

      it(`${stack.name}: every variable passed to ${service} is one it reads`, () => {
        const readers = new Set(VARS.filter(s => readBy(s, service)).map(s => nameFor(s, service)))
        expect([...passed].filter(k => !readers.has(k))).toEqual([])
      })

      it(`${stack.name}: every ${service} variable of this shape is passed (or says why not)`, () => {
        const missing = VARS
          .filter(s => readBy(s, service) && !s.notPassed && stack.scopes.includes(s.scope))
          .map(s => nameFor(s, service))
          .filter(n => !passed.has(n))
        expect(missing).toEqual([])
      })
    }

    it(`${stack.name}: every interpolated variable is in the registry`, () => {
      expect([...interpolations(stack.files).keys()].filter(k => !KNOWN.has(k))).toEqual([])
    })
  }
})

describe('deploy paths ↔ compose', () => {
  const prodNeeds = [...interpolations(STACKS[0]!.files)].filter(([, hasDefault]) => !hasDefault).map(([k]) => k)

  // Consumed by the deploy path itself (turned into PGSSLROOTCERT).
  const DEPLOY_ONLY = new Set(['OVH_PG_HOST', 'OVH_PG_CA_REMOTE_PATH'])
  // Docker Compose's own settings (which files make the stack), read by the
  // compose CLI on the host, not by markoto.
  const COMPOSE_CLI = new Set(['COMPOSE_FILE', 'COMPOSE_PROFILES'])
  // Exported on the host by the markoto-compose wrapper (the markoto user's
  // Podman socket, infra/roles/podman_host), not rendered into .env.
  const HOST_ENV = new Set(['CONTAINER_SOCKET'])
  const file = 'infra/render-env.sh'
  // The script's own list of inputs, not a .env line.
  const written = new Set([...assignments(file)].filter(k => k !== 'INPUTS'))

  it(`${file} writes every value deploy/compose/compose.prod.yml requires`, () => {
    expect(prodNeeds.filter(k => !written.has(k) && !HOST_ENV.has(k))).toEqual([])
  })

  it(`${file} writes only registered variables the hosted stack uses`, () => {
    const used = interpolations(STACKS[0]!.files)
    expect([...written].filter(k => !KNOWN.has(k) && !COMPOSE_CLI.has(k))).toEqual([])
    expect([...written].filter(k => !used.has(k) && !DEPLOY_ONLY.has(k) && !COMPOSE_CLI.has(k))).toEqual([])
  })

  it(`${file} names the production stack on Podman for the host's \`markoto-compose\``, () => {
    expect(read(file)).toMatch(/^COMPOSE_FILE=deploy\/compose\/compose\.prod\.yml:deploy\/compose\/compose\.podman\.yml$/m)
  })

  it('install.sh provides every value the self-host stack requires', () => {
    const script = read('install.sh')
    const needs = [...interpolations([...STACKS[1]!.files, 'deploy/compose/compose.selfhost.tls.yml'])]
      .filter(([, hasDefault]) => !hasDefault)
      .map(([k]) => k)
    expect(needs.filter(k => !script.includes(`${k}=`) && !script.includes(`${k} `))).toEqual([])
  })

  it('deploy.yml hands render-env.sh every optional setting it reads', () => {
    // `${NAME:-…}` / `${NAME:?…}` in render-env.sh: a value the operator may
    // set in the GitHub Environment. Without a line in deploy.yml setting it
    // there silently does nothing.
    const reads = new Set([...read('infra/render-env.sh').matchAll(/\$\{([A-Z][A-Z0-9_]*):[-?]/g)].map(m => m[1]!))
    const passed = new Set([...read('.github/workflows/deploy.yml').matchAll(/^\s+([A-Z][A-Z0-9_]{2,}): \$\{\{/gm)].map(m => m[1]!))
    // Fixed for markoto.app by render-env.sh's defaults: the BYOK provider
    // allowlist, the platform AI defaults (aliases, no own endpoints) and the
    // Mistral embeddings. Other operators use install.sh, not this workflow.
    const fixedForHosted = new Set([
      'NUXT_AI_BYOK_ALLOWED_BASE_URLS', 'NUXT_AI_BYOK_ALLOW_PRIVATE_URLS',
      'NUXT_AI_DEFAULT_CHAT_API_KEY', 'NUXT_AI_DEFAULT_CHAT_BASE_URL',
      'NUXT_AI_DEFAULT_IMAGE_API_KEY', 'NUXT_AI_DEFAULT_IMAGE_BASE_URL',
      'NUXT_AI_DEFAULT_TRANSCRIBE_API_KEY', 'NUXT_AI_DEFAULT_TRANSCRIBE_BASE_URL',
      'NUXT_LITELLM_EMBEDDINGS_MODEL', 'NUXT_LITELLM_EMBEDDINGS_DIMS',
      'NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS', 'NUXT_LITELLM_EMBEDDINGS_TASK_HINTS',
      'EMBEDDINGS_UPSTREAM_MODEL', 'EMBEDDINGS_UPSTREAM_API_BASE', 'EMBEDDINGS_UPSTREAM_API_KEY'
    ])
    expect([...reads].filter(n => !passed.has(n) && !fixedForHosted.has(n))).toEqual([])
  })

  it('deploy.yml hands render-env.sh only registered variables', () => {
    // The `env:` block of the render step: NAME: ${{ secrets.X }} / ${{ vars.X }}.
    const names = [...read('.github/workflows/deploy.yml').matchAll(/^\s+([A-Z][A-Z0-9_]{2,}): \$\{\{ (?:secrets|vars)\./gm)].map(m => m[1]!)
    expect(names.length).toBeGreaterThan(20)
    // The deploy job's own SSH target, notification URL and the host's
    // registry login, never container settings.
    const ciOnly = new Set(['APPRISE_URLS', 'DEPLOY_HOST', 'DEPLOY_USER', 'GHCR_PULL_USER', 'GHCR_PULL_TOKEN'])
    expect(names.filter(n => !KNOWN.has(n) && !ciOnly.has(n))).toEqual([])
  })
})
