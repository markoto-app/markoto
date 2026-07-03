#!/usr/bin/env bun
/**
 * Destructive-migration guard.
 *
 * Flags backward-INCOMPATIBLE DDL in NEW/CHANGED drizzle migrations so a
 * change that would break code-only rollback can't merge unnoticed.
 *
 * Why this exists: the merge → staging → prod auto-promotion pipeline rolls
 * back CODE only (flip the image tag) and NEVER restores the database —
 * restoring a live prod DB would discard every user write since the snapshot
 * (docs, comments, and the continuous Y.js CRDT stream in yjs_documents).
 * For code-only rollback to be safe, every migration must be
 * backward-compatible: the PREVIOUS release must still run against the NEW
 * schema (expand-contract). Dropping / renaming / retyping a column or adding
 * a NOT NULL constraint the old code doesn't satisfy breaks that.
 *
 * This is NOT a ban on destructive DDL — it's the CONTRACT phase of
 * expand-contract. Dropping a column is fine ONCE A PRIOR RELEASE stopped
 * reading it. To acknowledge that (or any other reviewed exception), add a
 * line to the migration .sql file:
 *
 *   -- allow-destructive: <reason> (e.g. "col unused since v1.4, contract phase")
 *
 * Usage:
 *   bun scripts/check-destructive-migrations.ts [file.sql ...]
 *     - with file args: checks exactly those files.
 *     - no args: checks drizzle/*.sql files changed vs BASE_REF (default
 *       origin/main). Set BASE_REF to override the diff base.
 *
 * Only CHANGED files are checked — historical migrations (which legitimately
 * contain DROP/TRUNCATE) are never re-scanned.
 */
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

interface Rule {
  re: RegExp
  what: string
}

// Backward-incompatible statements. Patterns run against comment-stripped,
// whitespace-normalised SQL so they can't span statements loosely.
const RULES: Rule[] = [
  { re: /\bDROP\s+TABLE\b/i, what: 'DROP TABLE' },
  { re: /\bDROP\s+COLUMN\b/i, what: 'DROP COLUMN' },
  { re: /\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+TYPE|TYPE)\b/i, what: 'ALTER COLUMN … TYPE (column rewrite)' },
  { re: /\bRENAME\s+COLUMN\b/i, what: 'RENAME COLUMN' },
  { re: /\bRENAME\s+TO\b/i, what: 'RENAME TABLE' },
  { re: /\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b/i, what: 'SET NOT NULL on existing column' },
  { re: /\bTRUNCATE\b/i, what: 'TRUNCATE' }
]

// Deliberately NOT flagged (backward-compatible): DROP INDEX (perf only),
// DROP CONSTRAINT (loosening), ADD COLUMN … DEFAULT (backfills), CREATE *.

const ALLOW_MARKER = /--\s*allow-destructive:\s*\S/i

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
}

function changedMigrationFiles(): string[] {
  const base = process.env.BASE_REF || 'origin/main'
  try {
    const out = execSync(
      `git diff --name-only --diff-filter=AM ${base}...HEAD -- 'drizzle/*.sql'`,
      { encoding: 'utf8' }
    )
    return out.split('\n').map(s => s.trim()).filter(Boolean)
  } catch (e) {
    console.error(`[migration-guard] could not diff against ${base}: ${e instanceof Error ? e.message : e}`)
    console.error('[migration-guard] pass migration files explicitly, or set BASE_REF.')
    process.exit(2)
  }
}

const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : changedMigrationFiles()

if (files.length === 0) {
  console.log('[migration-guard] no changed migration files — OK.')
  process.exit(0)
}

let violations = 0
for (const file of files) {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    console.error(`[migration-guard] cannot read ${file} — skipping.`)
    continue
  }
  const acknowledged = ALLOW_MARKER.test(raw)
  const sql = stripComments(raw)
  const hits = RULES.filter(r => r.re.test(sql)).map(r => r.what)
  if (hits.length === 0) continue

  if (acknowledged) {
    console.log(`[migration-guard] ${file}: ${hits.join(', ')} — acknowledged via "-- allow-destructive:" ✓`)
    continue
  }
  violations++
  console.error(`\n[migration-guard] ✗ ${file}`)
  console.error(`  Destructive / backward-incompatible DDL: ${hits.join(', ')}`)
}

if (violations > 0) {
  console.error(`\n${violations} migration(s) contain backward-incompatible DDL.`)
  console.error('The deploy pipeline rolls back CODE only and never restores the DB, so')
  console.error('the previous release must keep working against the new schema.')
  console.error('Options:')
  console.error('  • Split into expand-contract: ship the additive part now, do the DROP/')
  console.error('    RENAME/TYPE change in a LATER release once no running code uses it.')
  console.error('  • If this IS the contract phase (or a reviewed exception), add a line to')
  console.error('    the .sql file:  -- allow-destructive: <reason>')
  process.exit(1)
}

console.log(`[migration-guard] ${files.length} changed migration(s) checked — no unacknowledged destructive DDL. ✓`)
