#!/usr/bin/env bun
/**
 * Asserts whether a built `.output/` contains the test-only routes
 * (server/api/_test/**: the login shim and friends).
 *
 *   bun scripts/check-test-routes.ts --absent [outputDir]   # release builds (Dockerfile)
 *   bun scripts/check-test-routes.ts --present [outputDir]  # test builds (MARKOTO_TEST_BUILD=1)
 */

import { testRoutesInBuild } from './lib/testRoutesInBuild'

const args = process.argv.slice(2)
const expectPresent = args.includes('--present')
if (!expectPresent && !args.includes('--absent')) {
  console.error('usage: check-test-routes.ts --absent|--present [outputDir]')
  process.exit(2)
}
const outputDir = args.find(a => !a.startsWith('--')) ?? '.output'
const found = testRoutesInBuild(outputDir)

if (expectPresent && found.length === 0) {
  console.error(`[check-test-routes] ${outputDir} has no test routes: build it with MARKOTO_TEST_BUILD=1`)
  process.exit(1)
}
if (!expectPresent && found.length > 0) {
  console.error(`[check-test-routes] ${outputDir} contains test-only routes (built with MARKOTO_TEST_BUILD?):\n  ${found.join('\n  ')}`)
  process.exit(1)
}
console.log(`[check-test-routes] ok: test routes ${expectPresent ? 'present' : 'absent'} in ${outputDir}`)
