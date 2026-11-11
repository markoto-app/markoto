#!/usr/bin/env bun
/**
 * Re-encrypts every `users.litellm_key_token` after a `LITELLM_SALT_KEY`
 * rotation. Run this immediately after rotating the salt env var so
 * users don't lose access to their virtual keys (the proxy bearer
 * tokens are stored encrypted at rest with the salt-derived AES-256
 * key — once the salt changes, existing rows can't be decrypted).
 *
 * Procedure (operator):
 *   1. Generate a new salt:
 *        export NEW_LITELLM_SALT_KEY=sk-$(openssl rand -hex 32)
 *   2. Run this script with BOTH the old and new salts visible:
 *        OLD_LITELLM_SALT_KEY=$LITELLM_SALT_KEY \
 *        LITELLM_SALT_KEY=$NEW_LITELLM_SALT_KEY \
 *        bun scripts/rotate-litellm-salt.ts
 *   3. After the script reports success, update `.env` /
 *      group_vars to set LITELLM_SALT_KEY to the new value
 *      and remove OLD_LITELLM_SALT_KEY.
 *   4. Restart the app (so the new salt takes effect on subsequent
 *      ensureUserKey reads).
 *
 * Behaviour:
 *   - Reads every users row with non-null `litellm_key_token`.
 *   - For each, decrypts with OLD_LITELLM_SALT_KEY → re-encrypts with
 *     LITELLM_SALT_KEY → writes back. Wrapped in a single TX — either
 *     every row migrates or none do.
 *   - --dry-run prints the count without writing.
 *
 * Failure modes:
 *   - Mismatched OLD salt: every decryptToken throws. Aborts before
 *     any write happens. Caller fixes env vars and re-runs.
 *   - Half-rotated state from a previous failed run: the v1 token
 *     format prefix means re-running with the SAME old/new salts is
 *     a no-op (re-encrypted rows decrypt cleanly with the new salt
 *     already, so old-salt decrypt fails and the script aborts on
 *     the FIRST mismatched row — operator manually inspects).
 *
 * Notes:
 *   - LiteLLM ALSO encrypts its own internal token table with the
 *     salt. Rotating ours requires rotating the proxy's master_key/
 *     salt at the SAME time (or accepting that proxy-side tokens
 *     become unreadable). Coordinate via the proxy's restart cycle.
 *     See docs/operations/SECRETS-ROTATION.md for the joint procedure.
 */

import { Pool } from 'pg'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from 'node:crypto'

interface CliOpts {
  dryRun: boolean
}

function parseCli(): CliOpts {
  const argv = process.argv.slice(2)
  return { dryRun: argv.includes('--dry-run') }
}

function deriveKey(salt: string): Buffer {
  if (!salt || salt.length < 16) {
    throw new Error('salt must be ≥16 chars')
  }
  return createHash('sha256').update(salt, 'utf8').digest()
}

const TOKEN_VERSION = 'v1'

function decrypt(encrypted: string, salt: string): string {
  const parts = encrypted.split(':')
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) {
    throw new Error(`unsupported token format (expected v1:..., got ${parts[0]})`)
  }
  const [, ivB64, tagB64, ctB64] = parts
  const key = deriveKey(salt)
  const iv = Buffer.from(ivB64!, 'base64')
  const tag = Buffer.from(tagB64!, 'base64')
  const ct = Buffer.from(ctB64!, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf8')
}

function encrypt(plaintext: string, salt: string): string {
  const key = deriveKey(salt)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${TOKEN_VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

function buildAppDbUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const user = process.env.POSTGRES_USER ?? 'ypad'
  const password = process.env.POSTGRES_PASSWORD ?? ''
  const host = process.env.POSTGRES_HOST ?? 'localhost'
  const port = process.env.POSTGRES_PORT ?? '5432'
  const db = process.env.POSTGRES_DB ?? 'ypad'
  return `postgres://${user}:${encodeURIComponent(password)}@${host}:${port}/${db}`
}

async function main(): Promise<void> {
  const { dryRun } = parseCli()

  const oldSalt = process.env.OLD_LITELLM_SALT_KEY
  const newSalt = process.env.LITELLM_SALT_KEY
  if (!oldSalt || !newSalt) {
    console.error('[rotate-salt] both OLD_LITELLM_SALT_KEY and LITELLM_SALT_KEY must be set')
    console.error('  See the header comment in scripts/rotate-litellm-salt.ts for the procedure.')
    process.exit(1)
  }
  if (oldSalt === newSalt) {
    console.error('[rotate-salt] OLD_LITELLM_SALT_KEY === LITELLM_SALT_KEY — nothing to rotate')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: buildAppDbUrl(), max: 1 })
  try {
    const rows = await pool.query<{ id: number, encrypted: string }>(
      `SELECT id, litellm_key_token AS encrypted FROM users WHERE litellm_key_token IS NOT NULL`
    )
    console.log(`[rotate-salt] found ${rows.rows.length} users with encrypted tokens`)

    if (rows.rows.length === 0) {
      console.log('[rotate-salt] nothing to do')
      return
    }

    // Pre-flight: decrypt every row with the OLD salt + re-encrypt with
    // the NEW salt. We do this in memory FIRST, before any writes — so
    // a single bad row (e.g. mid-rotation state) aborts before the TX
    // touches anything.
    const updates: Array<{ id: number, next: string }> = []
    for (const row of rows.rows) {
      let plaintext: string
      try {
        plaintext = decrypt(row.encrypted, oldSalt)
      } catch (e) {
        throw new Error(
          `user_id=${row.id}: decrypt with OLD salt failed (${e instanceof Error ? e.message : e}). `
          + 'Either OLD_LITELLM_SALT_KEY is wrong, or this row was previously rotated to a different salt. Aborting.',
          { cause: e }
        )
      }
      updates.push({ id: row.id, next: encrypt(plaintext, newSalt) })
    }

    if (dryRun) {
      console.log(`[rotate-salt] DRY RUN — would re-encrypt ${updates.length} rows`)
      return
    }

    // Single transaction. Either every row updates or none — leaves
    // no half-rotated state behind.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const u of updates) {
        await client.query(
          `UPDATE users SET litellm_key_token = $1 WHERE id = $2`,
          [u.next, u.id]
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => { /* */ })
      throw e
    } finally {
      client.release()
    }

    console.log(`[rotate-salt] re-encrypted ${updates.length} rows. `
      + 'Update your .env to drop OLD_LITELLM_SALT_KEY and set LITELLM_SALT_KEY to the new value.')
  } finally {
    await pool.end()
  }
}

await main()
