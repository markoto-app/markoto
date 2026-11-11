#!/usr/bin/env bun
// Fails when tracked text files carry internal planning vocabulary
// ("WP4", "Phase 3", "Batch 2", "security batch B5", "Workstream B", "MMP").
// Comments and docs should say WHY something is the way it is; a milestone
// label is meaningless to anyone outside the planning tool and rots on its own.
//   bun scripts/checks/internal-vocabulary.mjs [--summary] [--json]
// Opt-out for a genuine non-milestone use (e.g. "Phase 1" of a protocol):
// put `vocab-ok` on the same line.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const PATTERN = /\b(WP ?\d+[a-z]?|Phase \d+|Batch \d+|[Ss]ecurity batch|batch B\d+|Workstream [A-Z]|MMP)\b/g

const EXCLUDE = [
  /^CHANGELOG\.md$/,
  /^drizzle\//,
  /^public\//,
  /^content\//,
  /(^|\/)(bun\.lock|bun\.lockb|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock)$/,
  /^scripts\/checks\/internal-vocabulary\.mjs$/, // holds the pattern itself
  /^tests\/unit\/repoHygiene\//,
  /(^|\/)node_modules\//,
  /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|pdf|zip|gz|docx|pptx|xlsx|mp4|webm)$/i
]

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 1 << 28
})
  .split('\0')
  .filter(f => f && !EXCLUDE.some(re => re.test(f)) && existsSync(join(root, f)))

const hits = []
for (const f of files) {
  const text = readFileSync(join(root, f), 'utf8')
  if (text.includes('\0')) continue
  text.split('\n').forEach((line, i) => {
    if (line.includes('vocab-ok')) return
    for (const m of line.matchAll(PATTERN)) hits.push({ file: f, line: i + 1, match: m[0] })
  })
}

if (process.argv.includes('--json')) console.log(JSON.stringify(hits, null, 2))
else {
  const byFile = new Map()
  for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1)
  if (process.argv.includes('--summary')) {
    const byDir = new Map()
    for (const h of hits) {
      const d = h.file.includes('/') ? h.file.split('/')[0] : '(root)'
      byDir.set(d, (byDir.get(d) ?? 0) + 1)
    }
    console.log('by top-level directory:')
    for (const [d, n] of [...byDir].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${d}`)
    console.log('top files:')
    for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${String(n).padStart(5)}  ${f}`)
  } else for (const h of hits) console.log(`${h.file}:${h.line}: ${h.match}`)
  console.log(`\n${hits.length} milestone label(s) in ${byFile.size} file(s)`)
}
process.exit(hits.length ? 1 : 0)
