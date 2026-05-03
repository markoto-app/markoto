#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// `bun run flows:test:changed [--diff-from=<ref>] [--include-deps]`
//
// Runs the flow test suite (via flows-ephemeral) but limited to the
// spec files that changed since `<ref>`. Default ref is the upstream
// merge-base (`HEAD@{upstream}` if it exists, otherwise `HEAD~1`) so
// the typical "I just edited a flow, run it" loop works without
// arguments.
//
// Quality-of-life on top of `flows:test`:
//   - When you've edited 1-3 flows, this skips the other 17. Local
//     full-suite is ~4 min; one flow is ~10-30 s.
//   - The orchestrator (docker stack + bun run build + Nuxt subprocess)
//     still has the same fixed cost — for a single flow that overhead
//     dominates and `flows:test:against-running` is faster IF you've
//     already got the prod build + infra up. This script is for the
//     "from cold" iteration loop.
//
// What "changed" means:
//   - Any `tests/e2e/flows/*.spec.ts` that has uncommitted modifications
//     OR has commits between `<ref>` and HEAD.
//   - With `--include-deps`: ALSO trigger every flow when shared infra
//     (`tests/e2e/fixtures/*`, `tests/e2e/page-objects/*`) changed —
//     because every spec depends on those, the safe answer is "run
//     them all". Off by default to keep the common case fast.
//
// Plumbing: forwards everything to scripts/flows-ephemeral.ts after
// appending the filtered spec paths as positional Playwright args.
// Playwright treats positional args as a path filter, so passing
// specific specs limits the run to them.

interface ParsedArgs {
  diffFrom: string | null
  includeDeps: boolean
  passthrough: string[]
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { diffFrom: null, includeDeps: false, passthrough: [] }
  for (const a of argv) {
    if (a.startsWith('--diff-from=')) out.diffFrom = a.slice('--diff-from='.length)
    else if (a === '--include-deps') out.includeDeps = true
    else out.passthrough.push(a)
  }
  return out
}

function defaultDiffBase(): string {
  // Prefer the upstream merge-base if a tracking branch is configured —
  // typical iteration is "diff against what's pushed". Fall back to
  // HEAD~1 when no upstream (detached HEAD, fresh branch).
  const upstream = spawnSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  if (upstream.status === 0) {
    const ref = upstream.stdout.toString().trim()
    if (ref) return ref
  }
  return 'HEAD~1'
}

function changedFiles(diffBase: string): string[] {
  // Two sources, unioned + deduped:
  //   1. Committed changes between `diffBase..HEAD` (`git diff --name-only`).
  //   2. Uncommitted modifications in the working tree (`git status --porcelain`).
  // The union covers "I committed half + still editing" workflows.
  const committed = spawnSync('git', ['diff', '--name-only', `${diffBase}...HEAD`], {
    stdio: ['ignore', 'pipe', 'inherit']
  })
  if (committed.status !== 0) {
    console.error(`[flows:test:changed] git diff against ${diffBase} failed.`)
    process.exit(1)
  }
  const committedFiles = committed.stdout.toString().split('\n').filter(Boolean)

  const status = spawnSync('git', ['status', '--porcelain'], { stdio: ['ignore', 'pipe', 'inherit'] })
  // Each porcelain line is `XY path`, e.g. ` M tests/e2e/flows/foo.spec.ts`
  // or `?? tests/e2e/flows/new.spec.ts`. Slice off the 3-char prefix.
  const workingFiles = status.stdout.toString().split('\n').filter(Boolean).map(l => l.slice(3))

  return Array.from(new Set([...committedFiles, ...workingFiles]))
}

function pickSpecs(files: string[], includeDeps: boolean): string[] {
  const FLOW_SPEC_RE = /^tests\/e2e\/flows\/.+\.spec\.ts$/
  const SHARED_RE = /^tests\/e2e\/(fixtures|page-objects)\//

  const specs = files.filter(f => FLOW_SPEC_RE.test(f) && existsSync(resolve(f)))
  const sharedTouched = files.some(f => SHARED_RE.test(f))

  if (sharedTouched && includeDeps) {
    console.log('[flows:test:changed] shared fixture/page-object changed AND --include-deps set — running ALL flows.')
    // Empty filter → playwright runs everything.
    return []
  }
  if (sharedTouched && !includeDeps) {
    console.log('[flows:test:changed] shared fixture/page-object changed but --include-deps NOT set; only running directly-modified spec files. Re-run with --include-deps to test the full suite.')
  }
  return specs
}

const args = parseArgs(process.argv.slice(2))
const diffBase = args.diffFrom ?? defaultDiffBase()
console.log(`[flows:test:changed] diff base: ${diffBase}`)

const files = changedFiles(diffBase)
const specs = pickSpecs(files, args.includeDeps)

if (specs.length === 0) {
  // Two cases land here: (a) no flow specs changed at all → nothing
  // to test, exit 0; (b) shared deps changed AND --include-deps was
  // set → empty filter means "run everything", forwarded as-is to
  // playwright.
  const sharedTouched = files.some(f => /^tests\/e2e\/(fixtures|page-objects)\//.test(f))
  if (!sharedTouched || !args.includeDeps) {
    console.log('[flows:test:changed] no flow specs changed since the diff base. Nothing to do.')
    process.exit(0)
  }
}

console.log(`[flows:test:changed] running ${specs.length || 'ALL'} flow spec${specs.length === 1 ? '' : 's'}:`)
for (const s of specs) console.log(`  ${s}`)

// Forward to flows-ephemeral with the filtered paths appended. Anything
// the user passed (e.g. `--project=en-light-desktop`) lands in
// passthrough and is forwarded too.
const result = spawnSync(
  'bun',
  ['scripts/flows-ephemeral.ts', ...args.passthrough, ...specs],
  { stdio: 'inherit' }
)
process.exit(result.status ?? 1)
