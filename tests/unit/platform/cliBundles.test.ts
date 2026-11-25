import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// The operator CLIs in the app image are single files made by `bun build`
// (Dockerfile). `bun build` replaces `process.env.NODE_ENV` with the
// image build's NODE_ENV ('development'), so a production check written
// that way folds to `false` and the CLI connects to Postgres without TLS,
// which managed Postgres refuses. These tests bundle every CLI the way the
// Dockerfile does and check that the TLS decision survives to runtime.

const ROOT = resolve(__dirname, '../../..')
const OUT = mkdtempSync(join(tmpdir(), 'markoto-cli-bundles-'))
afterAll(() => rmSync(OUT, { recursive: true, force: true }))

interface CliBuild { entry: string, flags: string[] }

/** Every `RUN bun build <entry> <flags>` of the Dockerfile. */
function dockerfileCliBuilds(): CliBuild[] {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
  return [...dockerfile.matchAll(/^RUN bun build (\S+)((?: --\S+)*)\s*$/gm)].map(m => ({
    entry: m[1]!,
    // The output path is the test's own.
    flags: m[2]!.trim().split(/\s+/).filter(f => !f.startsWith('--outfile='))
  }))
}

function bundle(entry: string, flags: string[]): string {
  const outfile = join(OUT, `${entry.replace(/[^\w.-]/g, '_')}.js`)
  const r = spawnSync('bun', ['build', entry, ...flags, `--outfile=${outfile}`], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`bun build ${entry} failed:\n${r.stderr}`)
  return outfile
}

/** The argument text of every `name(...)` call (not the definition). */
function callArguments(code: string, name: string): string[] {
  const calls: string[] = []
  const re = new RegExp(`(?<!function )\\b${name}\\(`, 'g')
  for (const m of code.matchAll(re)) {
    const start = m.index + m[0].length
    let depth = 1
    let i = start
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth++
      else if (code[i] === ')') depth--
      i++
    }
    calls.push(code.slice(start, i - 1))
  }
  return calls
}

/** The last top-level argument of an argument list. */
function lastArgument(args: string): string {
  let depth = 0
  let cut = 0
  for (let i = 0; i < args.length; i++) {
    const c = args[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) cut = i + 1
  }
  return args.slice(cut).trim()
}

const CLI_BUILDS = dockerfileCliBuilds()

describe('operator CLI bundles', () => {
  it('finds the CLIs the Dockerfile bundles', () => {
    expect(CLI_BUILDS.map(b => b.entry)).toEqual(expect.arrayContaining([
      'scripts/reembed-knowledge.ts',
      'scripts/reencrypt-secrets.ts',
      'scripts/waitlist-launch-email.ts'
    ]))
    for (const b of CLI_BUILDS) expect(b.flags).toContain('--target=bun')
  })

  it.each(CLI_BUILDS)('$entry decides Postgres TLS at runtime', ({ entry, flags }) => {
    const code = readFileSync(bundle(entry, flags), 'utf8')
    const calls = callArguments(code, 'resolvePostgresSsl')
    // Every bundled CLI talks to Postgres; no call means the check is blind.
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) {
      expect(lastArgument(args), `resolvePostgresSsl(${args})`).not.toMatch(/^(?:true|false|!0|!1|"[^"]*"\s*[!=]==?\s*"[^"]*")$/)
    }
    // No NODE_ENV comparison folded into two string literals either.
    expect(code).not.toMatch(/"(?:development|production|test)"\s*[!=]==?\s*"(?:development|production|test)"/)
  }, 60_000)

  it('a bundled pool connects with verified TLS under NODE_ENV=production', () => {
    const probe = bundle('tests/fixtures/cli-bundles/postgresSslProbe.ts', ['--target=bun'])
    const ca = join(OUT, 'ca.pem')
    writeFileSync(ca, 'FAKE CA\n')
    const base = { PATH: process.env.PATH, POSTGRES_USER: 'u', POSTGRES_PASSWORD: 'p', POSTGRES_HOST: 'db', POSTGRES_DB: 'markoto' }
    const run = (env: Record<string, string | undefined>): unknown => {
      const r = spawnSync('bun', [probe], { cwd: OUT, env, encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`probe failed:\n${r.stderr}`)
      return JSON.parse(r.stdout)
    }

    const tls = { rejectUnauthorized: true, ca: 'FAKE CA\n' }
    expect(run({ ...base, NODE_ENV: 'production', PGSSLROOTCERT: ca })).toEqual({ app: tls, litellm: tls, umami: tls })
    expect(run({ ...base, NODE_ENV: 'production' })).toEqual({
      app: { rejectUnauthorized: true },
      litellm: { rejectUnauthorized: true },
      umami: { rejectUnauthorized: true }
    })
    expect(run(base)).toEqual({ app: false, litellm: false, umami: false })
  }, 60_000)
})
