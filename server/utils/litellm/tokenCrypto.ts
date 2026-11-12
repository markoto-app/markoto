import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { useEnv } from '~~/shared/env/load'

// AES-256-GCM at-rest encryption for the per-user LiteLLM virtual-key
// bearer tokens. Keyed off `LITELLM_SALT_KEY` (the salt LiteLLM itself
// uses for its internal token-table encryption — reusing it keeps the
// secret-rotation surface unchanged).
//
// File scope: the cipher primitives + the version-prefixed wire format.
// No DB I/O, no LiteLLM admin HTTP, no Nuxt runtime config — pure node
// crypto so the AES-GCM code is auditable independently of the
// surrounding orchestration.

/** Format prefix so future re-keying / cipher swaps are non-destructive. */
const TOKEN_VERSION = 'v1'

/**
 * Derive a 32-byte AES-256 key from the configured salt. The salt is
 * already required at boot (see 01-validate-secrets.ts) so this can't
 * silently fall back to a default.
 */
function deriveTokenKey(): Buffer {
  const salt = useEnv().litellm.saltKey
  if (!salt) {
    throw new Error('[litellmKeys] LITELLM_SALT_KEY must be set before encrypting tokens')
  }
  // SHA-256 of the salt → 32 bytes of key material. Deterministic, no
  // additional KDF required given the salt is already a high-entropy
  // secret (`sk-${64-hex-chars}` per setup script).
  return createHash('sha256').update(salt, 'utf8').digest()
}

/**
 * AES-256-GCM encryption with random IV per call. Output format:
 *   `v1:{base64-iv}:{base64-tag}:{base64-ciphertext}`
 * Self-contained — no external state needed for decryption beyond
 * the salt env var.
 */
export function encryptToken(plaintext: string): string {
  const key = deriveTokenKey()
  const iv = randomBytes(12) // GCM standard
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${TOKEN_VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

export function decryptToken(encrypted: string): string {
  const parts = encrypted.split(':')
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) {
    throw new Error('[litellmKeys] encrypted token has unsupported format')
  }
  const [, ivB64, tagB64, ctB64] = parts
  const key = deriveTokenKey()
  const iv = Buffer.from(ivB64!, 'base64')
  const tag = Buffer.from(tagB64!, 'base64')
  const ct = Buffer.from(ctB64!, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf8')
}
