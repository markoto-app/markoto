#!/usr/bin/env node
// Fails when server/db/schema.ts has changes that no committed migration
// covers, i.e. `drizzle-kit generate` would emit a new migration. Runs
// against a throwaway copy of drizzle/ so the working tree is never touched,
// and needs no database.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const work = mkdtempSync(join(tmpdir(), 'markoto-drift-'))
try {
  const out = join(work, 'drizzle')
  cpSync(join(root, 'drizzle'), out, { recursive: true })
  const config = join(work, 'drizzle.config.mjs')
  writeFileSync(config, `export default {
  schema: ${JSON.stringify(join(root, 'server/db/schema.ts'))},
  out: './drizzle',
  dialect: 'postgresql'
}\n`)
  const before = new Set(readdirSync(out))
  const run = spawnSync(join(root, 'node_modules/.bin/drizzle-kit'), ['generate', '--config', config], { cwd: work, encoding: 'utf8' })
  const added = readdirSync(out).filter(f => !before.has(f))
  if (run.status !== 0) {
    console.error(run.stdout + run.stderr)
    process.exit(run.status ?? 1)
  }
  if (added.length > 0) {
    console.error(`server/db/schema.ts differs from the committed migrations (drizzle-kit would create: ${added.join(', ')}).`)
    console.error('Run `bun run db:generate` and commit the new migration + snapshot.')
    process.exit(1)
  }
  console.log('schema and migrations are in sync')
} finally {
  rmSync(work, { recursive: true, force: true })
}
