// Shared secret-length validation used at startup by both the Nuxt app
// (server/plugins/01-validate-secrets.ts) and the sync-server
// (sync-server/src/validate-secrets.ts). Centralised here so the minimum
// length and the check shape stay in sync across both boundaries.
//
// 32 chars is a deliberate floor: short enough that `openssl rand -hex 32`
// (64 chars) clears it, long enough that a shell-typo placeholder like
// `dev-secret` or `changeme` fails loudly instead of silently booting an
// insecure prod stack.

export const SECRET_MIN_LENGTH = 32

export interface SecretCheck {
  name: string
  value: unknown
  /** When false, an empty/missing value is accepted (used for `*_PREVIOUS`
   *  rotation secrets, which are optional but still length-checked when
   *  present). Defaults to true. */
  required?: boolean
}

export function validateSecrets(checks: SecretCheck[]): string[] {
  const errors: string[] = []
  for (const { name, value, required = true } of checks) {
    if (typeof value !== 'string' || value.length === 0) {
      if (required) errors.push(`${name} is not set`)
      continue
    }
    if (value.length < SECRET_MIN_LENGTH) {
      errors.push(`${name} must be at least ${SECRET_MIN_LENGTH} chars (got ${value.length})`)
    }
  }
  return errors
}
