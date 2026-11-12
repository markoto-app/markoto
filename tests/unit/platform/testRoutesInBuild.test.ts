import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { testRoutesInBuild } from '../../../scripts/lib/testRoutesInBuild'

// The check the Dockerfile runs on every release build: test-only routes
// (the login shim) must not be compiled in.

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function output(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'markoto-output-'))
  dirs.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

describe('testRoutesInBuild', () => {
  it('finds a compiled test route chunk and its lazy import', () => {
    const root = output({
      'server/chunks/routes/api/_test/login.post.mjs': 'export default 1',
      'server/chunks/nitro/nitro.mjs': 'const h = () => import(\'../routes/api/_test/login.post.mjs\')'
    })
    expect(testRoutesInBuild(root)).toEqual([
      'server/chunks/nitro/nitro.mjs (imports a test route)',
      'server/chunks/routes/api/_test/login.post.mjs'
    ])
  })

  it('passes a production build, even one mentioning the folder in a string', () => {
    const root = output({
      'server/chunks/routes/api/health.get.mjs': 'export default 1',
      'server/chunks/nitro/nitro.mjs': 'const doc = "include the test-only routes (server/api/_test/**)"'
    })
    expect(testRoutesInBuild(root)).toEqual([])
  })

  it('treats a missing output as no test routes', () => {
    expect(testRoutesInBuild(join(tmpdir(), 'markoto-no-such-output'))).toEqual([])
  })
})
