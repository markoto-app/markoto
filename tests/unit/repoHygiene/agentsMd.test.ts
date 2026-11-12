import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// AGENTS.md files are loaded into every agent session, so each line costs
// context on every task. Keep them short and push detail into docs/ or code
// comments. The budgets live here, in one place.
const ROOT_MAX_LINES = 150
const NESTED_MAX_LINES = 100

// Files that are over budget today, with the size they may not exceed.
// This list only shrinks: trim a file, then lower or delete its entry. The
// "stale entry" test below fails once a file fits its budget, so a finished
// cleanup cannot silently keep its allowance.
const OVER_BUDGET_ALLOWANCE: Record<string, number> = {}

// AGENTS.md files missing from the root index table today. Also shrink-only.
const UNINDEXED_ALLOWANCE = new Set<string>([])

const repoRoot = join(__dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8')
const lineCount = (p: string) => read(p).replace(/\n$/, '').split('\n').length

const claudeFiles = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 1 << 28
})
  .split('\0')
  .filter(f => f === 'AGENTS.md' || f.endsWith('/AGENTS.md'))
  .sort()

const budgetFor = (f: string) => (f === 'AGENTS.md' ? ROOT_MAX_LINES : NESTED_MAX_LINES)

describe('AGENTS.md hygiene', () => {
  it('finds the AGENTS.md files', () => {
    expect(claudeFiles).toContain('AGENTS.md')
    expect(claudeFiles.length).toBeGreaterThan(5)
  })

  describe('root index', () => {
    const rootText = read('AGENTS.md')
    // The index lists each file as a backticked path in the table's first column.
    const indexed = (f: string) => rootText.includes('`' + f + '`')

    for (const f of claudeFiles.filter(x => x !== 'AGENTS.md')) {
      it(`${f} is listed in the root index`, () => {
        expect(UNINDEXED_ALLOWANCE.has(f) || indexed(f), `add \`${f}\` to the index table in AGENTS.md`).toBe(true)
      })
    }

    it('has no stale index allowance', () => {
      const stale = [...UNINDEXED_ALLOWANCE].filter(f => indexed(f) || !claudeFiles.includes(f))
      expect(stale, 'remove these from UNINDEXED_ALLOWANCE').toEqual([])
    })
  })

  describe('size budget', () => {
    for (const f of claudeFiles) {
      it(`${f} fits ${budgetFor(f)} lines (or its allowance)`, () => {
        const n = lineCount(f)
        const cap = OVER_BUDGET_ALLOWANCE[f] ?? budgetFor(f)
        expect(n, `${f} has ${n} lines, limit ${cap}`).toBeLessThanOrEqual(cap)
      })
    }

    it('has no stale size allowance', () => {
      const stale = Object.keys(OVER_BUDGET_ALLOWANCE).filter(
        f => !claudeFiles.includes(f) || lineCount(f) <= budgetFor(f)
      )
      expect(stale, 'these now fit their budget: delete them from OVER_BUDGET_ALLOWANCE').toEqual([])
    })
  })
})
