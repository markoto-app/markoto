#!/usr/bin/env bun
import fs from 'node:fs/promises'
import path from 'node:path'
import { readSkippedFlows, skippedFlowsMarkdown } from './lib/flowSkips'

// Lists the flows a run skipped because a live provider was down. Prints the
// list, appends it to the job summary ($GITHUB_STEP_SUMMARY) and writes it to
// `<flows dir>/.skipped-flows.md`, which travels with the `flow-output`
// artifact into the release notes (release.yml). Prints nothing and writes
// nothing when no flow was skipped.
//
//   bun scripts/flows-skipped-summary.ts [flows-dir]   (default tests/e2e/output/flows)

const root = process.argv[2] ?? 'tests/e2e/output/flows'
const markdown = skippedFlowsMarkdown(await readSkippedFlows(root))
if (markdown) {
  console.log(markdown)
  await fs.writeFile(path.join(root, '.skipped-flows.md'), `${markdown}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
}
