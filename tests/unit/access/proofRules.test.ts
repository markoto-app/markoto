import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it, expect } from 'vitest'
import { RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
import { proofRules } from '../../../scripts/lint/proofRules.mjs'

// The lint rules that keep capability proofs unforgeable outside the access
// layer (scripts/lint/proofRules.mjs, docs/SECURITY-HARDENING.md → tenancy).
// The proof classes already refuse object literals and outside `new` at the
// type level; these rules refuse the ways of lying to the compiler.

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const ROOT = join(__dirname, '..', '..', '..')
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'proof-forgery')
const PROBE = join(FIXTURE, 'probe.ts')

const rule = (name: string) => {
  const found = proofRules.rules?.[name]
  if (!found || typeof found === 'function') throw new Error(`no rule ${name}`)
  return found
}

const PRELUDE = `
import type { DocAccess, UserScope } from '../../../server/repos/proofs/mint'
declare function repo(p: DocAccess<'view'>): void
declare function withCtx(ctx: { access: DocAccess<'view'>, title: string }): void
declare const proof: DocAccess<'manage'>
declare const raw: unknown
export type { UserScope }
`
const code = (body: string) => `${PRELUDE}\n${body}\n`

describe('markoto/no-proof-forgery', () => {
  const tester = new RuleTester({
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: FIXTURE }
    }
  })
  const cast = [{ messageId: 'cast' }]
  const unsafe = [{ messageId: 'unsafe' }]

  tester.run('no-proof-forgery', rule('no-proof-forgery'), {
    valid: [
      { filename: PROBE, code: code('repo(proof)') },
      { filename: PROBE, code: code('const n = raw as number; export { n }') },
      { filename: PROBE, code: code('withCtx({ access: proof, title: raw as string })') },
      { filename: PROBE, code: code('export function f(p: DocAccess<\'view\'>): string { return p.docId }') }
    ],
    invalid: [
      { filename: PROBE, code: code('repo(raw as DocAccess<\'view\'>)'), errors: cast },
      { filename: PROBE, code: code('repo(<DocAccess<\'view\'>>raw)'), errors: cast },
      { filename: PROBE, code: code('repo(raw as unknown as Parameters<typeof repo>[0])'), errors: cast },
      { filename: PROBE, code: code('export const u = { userId: 1 } as UserScope'), errors: cast },
      { filename: PROBE, code: code('export const list = [raw] as Array<DocAccess<\'view\'>>'), errors: cast },
      { filename: PROBE, code: code('export const holder = raw as { access: DocAccess<\'view\'> }'), errors: cast },
      { filename: PROBE, code: code('repo(raw as never)'), errors: unsafe },
      { filename: PROBE, code: code('repo(JSON.parse(\'{}\'))'), errors: unsafe },
      { filename: PROBE, code: code('export const p: DocAccess<\'view\'> = Object.create(null)'), errors: unsafe },
      { filename: PROBE, code: code('withCtx({ access: raw as never, title: \'\' })'), errors: unsafe },
      { filename: PROBE, code: code('export function g(): DocAccess<\'view\'> { return JSON.parse(\'{}\') }'), errors: unsafe }
    ]
  })
})

describe('markoto/proof-entry-imports', () => {
  const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } })
  const at = (path: string) => join(ROOT, path)
  const entry = (name: string) => [{ messageId: 'entry', data: { name } }]

  tester.run('proof-entry-imports', rule('proof-entry-imports'), {
    valid: [
      { filename: at('server/utils/agentic/sessionGuard.ts'), code: 'import { proveDocMembership } from \'../access/docProof\'' },
      { filename: at('server/utils/api/policy.ts'), code: 'proveSelf(1)' },
      { filename: at('server/utils/api/policyDoc.ts'), code: 'import { docProofFor } from \'../access/docProof\'' },
      { filename: at('server/utils/access/anything.ts'), code: 'proveNewDoc(null, \'d\')' },
      // Derives a document proof from a workspace proof: usable anywhere.
      { filename: at('server/api/workspaces/x.post.ts'), code: 'import { proveWorkspaceDoc } from \'../../utils/access/docProof\'' },
      // A local binding of the same name is not the access-layer function.
      { filename: at('server/api/docs/x.get.ts'), code: 'const proveSelf = (n: number) => n; proveSelf(1)' }
    ],
    invalid: [
      { filename: at('server/api/docs/x.get.ts'), code: 'import { proveDocMembership } from \'../../utils/access/docProof\'', errors: entry('proveDocMembership') },
      // Nitro auto-import: no import statement, same use.
      { filename: at('server/utils/billing/x.ts'), code: 'proveWorkspaceAccess(1, \'w\', \'member\')', errors: entry('proveWorkspaceAccess') },
      { filename: at('server/mcp/tools/x.ts'), code: 'import { proveNewDoc } from \'../../utils/access/docProof\'', errors: entry('proveNewDoc') },
      { filename: at('server/utils/api/policyWorkspace.ts'), code: 'import { docProofFor } from \'../access/docProof\'', errors: entry('docProofFor') },
      { filename: at('server/api/admin/x.get.ts'), code: 'import { proveAdmin } from \'../../utils/access/userProof\'', errors: entry('proveAdmin') }
    ]
  })
})

describe('the proof rules are wired and not silenced', () => {
  it('eslint.config.mjs turns both rules on', () => {
    const config = readFileSync(join(ROOT, 'eslint.config.mjs'), 'utf8')
    expect(config).toContain('\'markoto/no-proof-forgery\': \'error\'')
    expect(config).toContain('\'markoto/proof-entry-imports\': [\'error\', PROOF_ENTRY_CALLERS]')
  })

  it('no production server file disables them', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        if (statSync(p).isDirectory()) walk(p, out)
        else if (p.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(p)) out.push(p)
      }
      return out
    }
    const hits = walk(join(ROOT, 'server'))
      .filter(p => /eslint-disable[^\n]*(no-proof-forgery|proof-entry-imports|ban-ts-comment)/.test(readFileSync(p, 'utf8')))
      .map(p => relative(ROOT, p))
    expect(hits).toEqual([])
  })
})
