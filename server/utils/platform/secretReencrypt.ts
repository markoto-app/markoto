import { listSealedSecrets, replaceSealedSecret, SEALED_SECRET_KINDS, type SealedSecretKind, type SealedSecretRow, type SqlPool } from '../../repos/storedSecrets'
import { openSecret, sealSecret, secretContext, SecretUnreadableError, type SecretPurpose } from './secretBox'

// Rewrites every stored secret with the current NUXT_ENCRYPTION_KEY, so
// NUXT_ENCRYPTION_KEY_PREVIOUS can be removed after a rotation. Raw SQL on a
// pg Pool (no Nitro, no Drizzle; the columns are in repos/storedSecrets.ts)
// because it also runs as the bundled CLI `cli/reencrypt-secrets.js` in the
// app image.

/** The sealing context of each stored secret, from its row identity. */
const CONTEXT: Record<SealedSecretKind, (row: SealedSecretRow) => string> = {
  'litellm-user-key': r => secretContext.litellmUserKey(Number(r.idA)),
  'litellm-member-key': r => secretContext.litellmMemberKey(String(r.idA), Number(r.idB)),
  'ai-provider-key': r => secretContext.aiProviderKey(Number(r.idA), String(r.idB)),
  'sso-client-secret': r => secretContext.ssoClientSecret(String(r.idA))
}

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
export async function reencryptStoredSecrets(pool: SqlPool, opts: { dryRun?: boolean } = {}): Promise<ReencryptSummary> {
  const summary: ReencryptSummary = { rewritten: 0, unreadable: [] }
  for (const kind of SEALED_SECRET_KINDS) {
    for (const row of await listSealedSecrets(pool, kind)) {
      let plaintext: string
      try {
        plaintext = openSecret(kind, CONTEXT[kind](row), row.sealed)
      } catch (e) {
        if (!(e instanceof SecretUnreadableError)) throw e
        summary.unreadable.push({ purpose: kind, row: [row.idA, row.idB].filter(v => v !== null).join(':') })
        continue
      }
      if (opts.dryRun) {
        summary.rewritten++
        continue
      }
      summary.rewritten += await replaceSealedSecret(pool, row, sealSecret(kind, CONTEXT[kind](row), plaintext))
    }
  }
  return summary
}
