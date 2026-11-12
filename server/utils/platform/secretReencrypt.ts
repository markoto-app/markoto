import type { Pool } from 'pg'
import { openSecret, sealSecret, secretContext, SecretUnreadableError, type SecretPurpose } from './secretBox'

// Rewrites every stored secret with the current NUXT_ENCRYPTION_KEY, so
// NUXT_ENCRYPTION_KEY_PREVIOUS can be removed after a rotation. Raw SQL on a
// pg Pool (no Nitro, no Drizzle) because it also runs as the bundled CLI
// `cli/reencrypt-secrets.js` in the app image.

interface Column {
  purpose: SecretPurpose
  /** Selects `id_a`, `id_b` (row identity for the UPDATE) and `sealed`. */
  select: string
  /** $1 = new value, then `keys(row)`, last = the old value (compare-and-swap). */
  update: string
  keys: (row: Row) => Array<string | number>
  context: (row: Row) => string
}

interface Row {
  id_a: string | number
  id_b: string | number | null
  sealed: string
}

const COLUMNS: Column[] = [
  {
    purpose: 'litellm-user-key',
    select: 'SELECT id AS id_a, NULL AS id_b, litellm_key_token AS sealed FROM users WHERE litellm_key_token IS NOT NULL',
    update: 'UPDATE users SET litellm_key_token = $1 WHERE id = $2 AND litellm_key_token = $3',
    keys: r => [Number(r.id_a)],
    context: r => secretContext.litellmUserKey(Number(r.id_a))
  },
  {
    purpose: 'litellm-member-key',
    select: 'SELECT workspace_id AS id_a, user_id AS id_b, litellm_key_token AS sealed FROM workspace_members WHERE litellm_key_token IS NOT NULL',
    update: 'UPDATE workspace_members SET litellm_key_token = $1 WHERE workspace_id = $2 AND user_id = $3 AND litellm_key_token = $4',
    keys: r => [String(r.id_a), Number(r.id_b)],
    context: r => secretContext.litellmMemberKey(String(r.id_a), Number(r.id_b))
  },
  {
    purpose: 'ai-provider-key',
    select: 'SELECT user_id AS id_a, capability AS id_b, api_key_encrypted AS sealed FROM user_ai_providers',
    update: 'UPDATE user_ai_providers SET api_key_encrypted = $1 WHERE user_id = $2 AND capability = $3 AND api_key_encrypted = $4',
    keys: r => [Number(r.id_a), String(r.id_b)],
    context: r => secretContext.aiProviderKey(Number(r.id_a), String(r.id_b))
  },
  {
    purpose: 'sso-client-secret',
    select: 'SELECT workspace_id AS id_a, NULL AS id_b, oidc_client_secret AS sealed FROM sso_connections WHERE oidc_client_secret IS NOT NULL',
    update: 'UPDATE sso_connections SET oidc_client_secret = $1 WHERE workspace_id = $2 AND oidc_client_secret = $3',
    keys: r => [String(r.id_a)],
    context: r => secretContext.ssoClientSecret(String(r.id_a))
  }
]

export interface ReencryptSummary {
  rewritten: number
  /** Rows neither key decrypts: left untouched (the app treats them as absent). */
  unreadable: Array<{ purpose: SecretPurpose, row: string }>
}

/**
 * Decrypt each stored secret (current key, then previous) and write it
 * back sealed with the current key. A row changed concurrently is skipped
 * (the compare-and-swap on the old value): whoever wrote it already used the current key.
 */
export async function reencryptStoredSecrets(pool: Pool, opts: { dryRun?: boolean } = {}): Promise<ReencryptSummary> {
  const summary: ReencryptSummary = { rewritten: 0, unreadable: [] }
  for (const col of COLUMNS) {
    const { rows } = await pool.query<Row>(col.select)
    for (const row of rows) {
      let plaintext: string
      try {
        plaintext = openSecret(col.purpose, col.context(row), row.sealed)
      } catch (e) {
        if (!(e instanceof SecretUnreadableError)) throw e
        summary.unreadable.push({ purpose: col.purpose, row: [row.id_a, row.id_b].filter(v => v !== null).join(':') })
        continue
      }
      if (opts.dryRun) {
        summary.rewritten++
        continue
      }
      const resealed = sealSecret(col.purpose, col.context(row), plaintext)
      const res = await pool.query(col.update, [resealed, ...col.keys(row), row.sealed])
      summary.rewritten += res.rowCount ?? 0
    }
  }
  return summary
}
