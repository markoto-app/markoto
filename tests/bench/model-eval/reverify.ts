// Re-runs the task verifiers on stored runs (artifact patch applied to the
// fixture) after a verifier fix, and rewrites the results file in place.
//   bun tests/bench/model-eval/reverify.ts <results.jsonl> <artifacts-dir>
import { readFileSync, writeFileSync } from 'node:fs'
import { applyPatch } from 'diff'
import { largeDocument } from './fixtures'
import { PLANNER_TASKS, smallDocText } from './tasks'

const [resultsPath, artifacts] = process.argv.slice(2)
const LARGE = largeDocument()
const rows = readFileSync(resultsPath!, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
let changed = 0
for (const r of rows) {
  const task = PLANNER_TASKS.find(t => t.id === r.task)!
  const art = JSON.parse(readFileSync(`${artifacts}/${r.label}-${r.model}-${r.task}-${r.rep}.json`, 'utf8')) as { patch?: string, comments: never[] }
  if (!art.patch) continue
  const initial = task.doc === 'large' ? LARGE : smallDocText(task.doc)!
  const final = applyPatch(initial, art.patch)
  if (final === false) {
    console.log('patch failed', r.model, r.task, r.rep)
    continue
  }
  const v = task.verify(initial, final, art.comments)
  if (v.ok !== r.ok || v.score !== r.score) {
    changed++
    console.log(`${r.model} ${r.task} #${r.rep}: ${r.ok}/${r.score} -> ${v.ok}/${v.score.toFixed(2)} ${v.detail}`)
  }
  Object.assign(r, { ok: v.ok, score: v.score, detail: v.detail })
}
writeFileSync(resultsPath!, `${rows.map(r => JSON.stringify(r)).join('\n')}\n`)
console.log(`reverified ${rows.length} rows, ${changed} changed`)
