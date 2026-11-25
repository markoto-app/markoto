#!/usr/bin/env bun
/**
 * Re-encrypt every secret the app stores (LiteLLM virtual keys, BYOK
 * provider keys, SSO client secrets) with the current NUXT_ENCRYPTION_KEY,
 * after a rotation. `bun run secrets:reencrypt [-- --dry-run]`.
 *
 * Inside the stack (the app container has every variable below):
 *   docker compose exec app bun cli/reencrypt-secrets.js --dry-run
 *
 * Procedure (the operator runbook, kept outside this repository): move the old key into
 * NUXT_ENCRYPTION_KEY_PREVIOUS, set a new NUXT_ENCRYPTION_KEY, restart, run
 * this, then empty _PREVIOUS. Rows that neither key decrypts are listed and
 * left alone; the app treats them as absent (new LiteLLM key minted, BYOK
 * key / SSO client secret must be entered again).
 *
 * Environment: NUXT_ENCRYPTION_KEY (+ _PREVIOUS), POSTGRES_* or DATABASE_URL.
 * Keep it free of Nitro auto-imports so the bundle runs standalone.
 */

import { Pool } from 'pg'
import { reencryptStoredSecrets } from '../server/utils/platform/secretReencrypt'
import { postgresUrlFromEnv } from '../shared/utils/runtime/connectionStrings'
import { resolvePostgresSsl } from '../shared/utils/runtime/postgresSsl'
import { useEnv } from '../shared/env/load'
import { isProduction } from '../shared/env/runtime'

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes('--dry-run')
  const env = useEnv()
  if (!env.auth.encryptionKey) throw new Error('NUXT_ENCRYPTION_KEY is required')
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || postgresUrlFromEnv(env.database),
    ssl: resolvePostgresSsl(env.database, isProduction()),
    max: 1
  })
  try {
    const summary = await reencryptStoredSecrets(pool, { dryRun })
    console.log(`[reencrypt] ${dryRun ? 'would rewrite' : 'rewrote'} ${summary.rewritten} secrets`)
    for (const u of summary.unreadable) console.warn(`[reencrypt] unreadable with either key, left as is: ${u.purpose} ${u.row}`)
    if (summary.unreadable.length === 0 && !dryRun) console.log('[reencrypt] done: NUXT_ENCRYPTION_KEY_PREVIOUS can be emptied')
  } finally {
    await pool.end()
  }
}

try {
  await main()
} catch (e) {
  console.error('[reencrypt] FAILED (safe to re-run):', e instanceof Error ? e.message : e)
  process.exit(1)
}
