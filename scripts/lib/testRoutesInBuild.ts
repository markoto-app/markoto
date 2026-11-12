import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Finds the test-only routes (server/api/_test/**) in a built Nitro output.
// Nitro emits each route handler as its own chunk under
// `server/chunks/routes/api/…` and imports it lazily from the route table, so
// a compiled-in test route shows up as a file path and as an import specifier.
// nuxt.config.ts leaves them out unless MARKOTO_TEST_BUILD=1.

const ROUTE_DIR = '/routes/api/_test/'

/** Evidence of test routes in `<outputDir>/server`, as paths relative to `outputDir`. Empty = none. */
export function testRoutesInBuild(outputDir: string): string[] {
  const serverDir = join(outputDir, 'server')
  const found: string[] = []
  if (!existsSync(serverDir)) return found
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      const rel = relative(outputDir, path).split('\\').join('/')
      if (`/${rel}`.includes(ROUTE_DIR)) {
        found.push(rel)
      } else if (/\.m?js$/.test(name) && readFileSync(path, 'utf8').includes(`routes/api/_test/`)) {
        found.push(`${rel} (imports a test route)`)
      }
    }
  }
  walk(serverDir)
  return found
}
