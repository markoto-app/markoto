import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it, expect } from 'vitest'

// A capability proof can only be forged with a type assertion (the classes
// are nominal and their constructors take a module-private token), or by
// reaching the test-only mint. Production code does neither: this scan is
// the guard for the casts that ESLint and dependency-cruiser cannot see.

const ROOT = join(__dirname, '..', '..', '..')
const SCANNED = ['server', 'shared', 'app', 'modules', 'sync-server/src', 'renderer/src']
/** The proof module itself and the access layer that mints through it. */
const MINTERS = ['server/repos/proofs/', 'server/utils/access/']

const PROOF = String.raw`(?:DocAccess|WorkspaceAccess|UserScope|AdminActor|SystemActor)\b`
const RULES: Array<[string, RegExp]> = [
  ['`as` cast to a proof type', new RegExp(String.raw`\bas\s+(?:unknown\s+as\s+)?` + PROOF)],
  ['angle-bracket cast to a proof type', new RegExp(String.raw`<` + PROOF + String.raw`(?:<[^>]*>)?>\s*[\w(]`)],
  ['direct proof construction', new RegExp(String.raw`\bnew\s+` + PROOF)],
  ['the test-only mint', /proofs\/testing|__mint[A-Z]/]
]

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|vue|mts)$/.test(p) && !/\.(test|spec)\.ts$/.test(p)) out.push(p)
  }
  return out
}

describe('capability proofs cannot be forged in production code', () => {
  const files = SCANNED.flatMap(d => walk(join(ROOT, d)))
    .map(p => relative(ROOT, p))
    .filter(p => !MINTERS.some(m => p.startsWith(m)))

  it('scans the production tree', () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it('no cast to a proof type, no construction, no test mint outside the access layer', () => {
    const hits: string[] = []
    for (const file of files) {
      const lines = readFileSync(join(ROOT, file), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return
        for (const [what, re] of RULES) if (re.test(line)) hits.push(`${file}:${i + 1} ${what}: ${line.trim()}`)
      })
    }
    expect(hits).toEqual([])
  })

  it('the rules catch what they are meant to catch', () => {
    const samples = [
      'const p = row as DocAccess<\'manage\'>',
      'const p = x as unknown as UserScope',
      'const p = <WorkspaceAccess<\'admin\'>>x',
      'const p = new SystemActor(token, \'x\')',
      'import { __mintUserScope } from \'../repos/proofs/testing\''
    ]
    for (const sample of samples) expect(RULES.some(([, re]) => re.test(sample)), sample).toBe(true)
    expect(RULES.some(([, re]) => re.test('function f(p: DocAccess<\'view\'>): void {}'))).toBe(false)
  })
})
