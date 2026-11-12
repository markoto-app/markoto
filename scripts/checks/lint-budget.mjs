#!/usr/bin/env node
// Lint budget ratchet.
//
// `max-lines`, `max-lines-per-function` and `sonarjs/cognitive-complexity` stay
// at `warn` while the oversized files are split up. This check makes sure the
// backlog can only shrink:
//   - a budgeted hit in a file that is not in the baseline fails,
//   - a listed file with MORE hits than its baseline count fails,
//   - a listed file with FEWER hits fails too, telling you to shrink the
//     baseline (so a fixed file cannot quietly regrow later),
//   - any other warning, or any error, fails (every non-budgeted rule is an
//     `error`, so nothing else may warn).
//
//   node scripts/checks/lint-budget.mjs            check
//   node scripts/checks/lint-budget.mjs --update   rewrite the baseline from the current tree
//
// Runs ESLint without the type-aware rules (LINT_TYPES=off): none of the
// budgeted rules needs type information, and it keeps this check at seconds.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const BUDGETED_RULES = ['max-lines', 'max-lines-per-function', 'sonarjs/cognitive-complexity']

const root = resolve(import.meta.dirname, '../..')
const baselinePath = join(root, 'scripts/checks/lint-budget.baseline.json')
const update = process.argv.includes('--update')

const dir = mkdtempSync(join(tmpdir(), 'markoto-lint-budget-'))
const reportPath = join(dir, 'lint.json')
let report
try {
  // `bun --bun`: the ESLint config imports TypeScript and Nuxt-generated files.
  const run = spawnSync('bun', ['--bun', 'x', 'eslint', '.', '-f', 'json', '-o', reportPath], {
    cwd: root,
    env: { ...process.env, LINT_TYPES: 'off' },
    stdio: ['ignore', 'inherit', 'inherit'],
    maxBuffer: 1 << 28
  })
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch {
    console.error(`ESLint produced no report (exit ${run.status}); fix the configuration error above.`)
    process.exit(1)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

/** @type {Record<string, Record<string, number>>} rule -> file -> hits */
const current = Object.fromEntries(BUDGETED_RULES.map(rule => [rule, {}]))
const other = []
for (const file of report) {
  const path = relative(root, file.filePath)
  for (const m of file.messages) {
    if (BUDGETED_RULES.includes(m.ruleId) && m.severity === 1) {
      current[m.ruleId][path] = (current[m.ruleId][path] ?? 0) + 1
    } else {
      other.push(`${path}:${m.line}:${m.column} ${m.severity === 2 ? 'error' : 'warning'} ${m.ruleId ?? '(parse)'} ${m.message}`)
    }
  }
}

const sorted = obj => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

if (update) {
  const next = Object.fromEntries(BUDGETED_RULES.map(rule => [rule, sorted(current[rule])]))
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n')
  const total = BUDGETED_RULES.map(r => `${r}: ${Object.keys(current[r]).length} files`).join(', ')
  console.log(`Baseline written (${total}).`)
  process.exit(0)
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const failures = []
const shrink = []
for (const rule of BUDGETED_RULES) {
  const base = baseline[rule] ?? {}
  for (const [file, hits] of Object.entries(current[rule])) {
    const allowed = base[file]
    if (allowed === undefined) failures.push(`${rule}: ${file} is not in the baseline but has ${hits} hit(s) — fix them instead of adding it.`)
    else if (hits > allowed) failures.push(`${rule}: ${file} grew from ${allowed} to ${hits} hit(s).`)
    else if (hits < allowed) shrink.push(`${rule}: ${file} ${allowed} -> ${hits}`)
  }
  for (const [file, allowed] of Object.entries(base)) {
    if (!(file in current[rule])) shrink.push(`${rule}: ${file} ${allowed} -> 0`)
  }
}
if (other.length > 0) {
  failures.push(`${other.length} warning(s)/error(s) from rules outside the budget (only ${BUDGETED_RULES.join(', ')} may warn):`, ...other.slice(0, 50).map(l => `  ${l}`))
  if (other.length > 50) failures.push(`  ... and ${other.length - 50} more (run \`bun run lint:fast\`)`)
}
if (shrink.length > 0) {
  failures.push('The lint budget improved — shrink the baseline (`bun run lint:budget:update`) and commit it:', ...shrink.map(l => `  ${l}`))
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
const total = BUDGETED_RULES.reduce((n, r) => n + Object.values(current[r]).reduce((a, b) => a + b, 0), 0)
console.log(`lint budget ok (${total} budgeted hit(s), none new)`)
