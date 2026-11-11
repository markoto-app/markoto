// Fails when the type checker would silently skip `.vue` files.
//
// Under the Bun runtime (`bun --bun run typecheck`) vue-tsc's Vue language
// plugin does not take effect, so only `.ts` files enter the program and
// every component error goes unreported while the check still exits 0.
// This lists the program's files and requires project `.vue` files in it.
// Run it with Node: `node scripts/check-typecheck-covers-vue.mjs`.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

if (process.versions.bun) {
  console.error('Run this guard with Node (node scripts/check-typecheck-covers-vue.mjs), not Bun.')
  process.exit(2)
}

const root = resolve(import.meta.dirname, '..')
const result = spawnSync(
  process.execPath,
  [resolve(root, 'node_modules/vue-tsc/bin/vue-tsc.js'), '--listFilesOnly', '-p', '.nuxt/tsconfig.app.json'],
  { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
)
if (result.status !== 0) {
  console.error(result.stderr || result.stdout)
  console.error('vue-tsc --listFilesOnly failed (is .nuxt prepared? run `bun run postinstall`).')
  process.exit(result.status ?? 1)
}

const appDir = `${resolve(root, 'app')}/`
const vueFiles = result.stdout.split('\n').filter(f => f.startsWith(appDir) && f.endsWith('.vue'))
if (vueFiles.length === 0) {
  console.error('Typecheck covers no app/**/*.vue files: component errors would go unreported.')
  process.exit(1)
}
console.log(`typecheck covers ${vueFiles.length} app .vue files`)
