import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

// `server/runtime/bunEntry.ts` is a hand-made copy of nitropack's `bun`
// preset entry (plus a request-body size limit). Nothing ties the copy to
// the installed preset, so a nitropack upgrade could change the preset
// (new Bun.serve options, a fix in the fetch handler, scheduled tasks, …)
// while the production build keeps running the stale copy.
//
// This pins the preset source the copy was derived from. When it fails:
// diff the installed preset against the snapshot, carry the change over
// into server/runtime/bunEntry.ts, then refresh the snapshot with
//   cp node_modules/nitropack/dist/presets/bun/runtime/bun.mjs \
//      tests/fixtures/nitropack/bun-preset-entry.mjs.txt

const ROOT = resolve(__dirname, '../../..')
const SNAPSHOT = join(ROOT, 'tests/fixtures/nitropack/bun-preset-entry.mjs.txt')

function installedPresetEntry(): string {
  const require = createRequire(join(ROOT, 'package.json'))
  const pkgDir = dirname(require.resolve('nitropack/package.json'))
  return readFileSync(join(pkgDir, 'dist/presets/bun/runtime/bun.mjs'), 'utf8')
}

describe('custom Bun server entry vs nitropack bun preset', () => {
  it('the installed preset entry still matches the snapshot bunEntry.ts was derived from', () => {
    const installed = installedPresetEntry()
    const snapshot = readFileSync(SNAPSHOT, 'utf8')
    expect(
      installed,
      'nitropack\'s bun preset entry changed: re-derive server/runtime/bunEntry.ts from '
      + 'node_modules/nitropack/dist/presets/bun/runtime/bun.mjs, then refresh '
      + 'tests/fixtures/nitropack/bun-preset-entry.mjs.txt (see this test\'s header)'
    ).toBe(snapshot)
  })

  it('bunEntry.ts names the snapshot it was derived from', () => {
    const entry = readFileSync(join(ROOT, 'server/runtime/bunEntry.ts'), 'utf8')
    expect(entry).toContain('tests/fixtures/nitropack/bun-preset-entry.mjs.txt')
  })
})
