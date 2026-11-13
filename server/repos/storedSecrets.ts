import type { Pool } from 'pg'

// Every column that stores a sealed secret, for the key-rotation tool
// (`server/utils/platform/secretReencrypt.ts`, run as the CLI
// `cli/reencrypt-secrets.js`). Raw SQL on a pg pool passed in by the
// caller: the CLI runs without Nitro and opens its own pool.

/** What the rotation tool needs of a pool. */
export type SqlPool = Pick<Pool, 'query'>

export type SealedSecretKind = 'litellm-user-key' | 'litellm-member-key' | 'ai-provider-key' | 'sso-client-secret'

export interface SealedSecretRow {
  kind: SealedSecretKind
  /** The row's identity (also the secret's sealing context). */
  idA: string | number
  idB: string | number | null
  sealed: string
}

interface Column {
  kind: SealedSecretKind
  /** Selects `id_a`, `id_b` and `sealed`. */
  select: string
  /** $1 = new value, then the keys, last = the old value (compare-and-swap). */
  update: string
  keys: (row: SealedSecretRow) => Array<string | number>
}

const COLUMNS: Column[] = [
  {
    kind: 'litellm-user-key',
    select: 'SELECT id AS id_a, NULL AS id_b, litellm_key_token AS sealed FROM users WHERE litellm_key_token IS NOT NULL',
    update: 'UPDATE users SET litellm_key_token = $1 WHERE id = $2 AND litellm_key_token = $3',
    keys: r => [Number(r.idA)]
  },
  {
    kind: 'litellm-member-key',
    select: 'SELECT workspace_id AS id_a, user_id AS id_b, litellm_key_token AS sealed FROM workspace_members WHERE litellm_key_token IS NOT NULL',
    update: 'UPDATE workspace_members SET litellm_key_token = $1 WHERE workspace_id = $2 AND user_id = $3 AND litellm_key_token = $4',
    keys: r => [String(r.idA), Number(r.idB)]
  },
  {
    kind: 'ai-provider-key',
    select: 'SELECT user_id AS id_a, capability AS id_b, api_key_encrypted AS sealed FROM user_ai_providers',
    update: 'UPDATE user_ai_providers SET api_key_encrypted = $1 WHERE user_id = $2 AND capability = $3 AND api_key_encrypted = $4',
    keys: r => [Number(r.idA), String(r.idB)]
  },
  {
    kind: 'sso-client-secret',
    select: 'SELECT workspace_id AS id_a, NULL AS id_b, oidc_client_secret AS sealed FROM sso_connections WHERE oidc_client_secret IS NOT NULL',
    update: 'UPDATE sso_connections SET oidc_client_secret = $1 WHERE workspace_id = $2 AND oidc_client_secret = $3',
    keys: r => [String(r.idA)]
  }
]

export const SEALED_SECRET_KINDS: readonly SealedSecretKind[] = COLUMNS.map(c => c.kind)

export async function listSealedSecrets(pool: SqlPool, kind: SealedSecretKind): Promise<SealedSecretRow[]> {
  const col = columnOf(kind)
  const { rows } = await pool.query<{ id_a: string | number, id_b: string | number | null, sealed: string }>(col.select)
  return rows.map(r => ({ kind, idA: r.id_a, idB: r.id_b, sealed: r.sealed }))
}

/** Replace a sealed value unless it changed since it was read (compare-and-swap). Returns the rows changed. */
export async function replaceSealedSecret(pool: SqlPool, row: SealedSecretRow, resealed: string): Promise<number> {
  const col = columnOf(row.kind)
  const res = await pool.query(col.update, [resealed, ...col.keys(row), row.sealed])
  return res.rowCount ?? 0
}

function columnOf(kind: SealedSecretKind): Column {
  const col = COLUMNS.find(c => c.kind === kind)
  if (!col) throw new Error(`unknown sealed secret kind ${kind}`)
  return col
}
