import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { useEnv } from '~~/shared/env/load'

// At-rest encryption of the secrets the app keeps in Postgres: LiteLLM
// virtual-key tokens, users' own AI provider keys (BYOK) and workspace SSO
// client secrets. A database dump, a backup or a SQL injection must not
// hand these out.
//
// Three properties beyond "AES-GCM with a random nonce":
//
// - Its own secret (NUXT_ENCRYPTION_KEY). LiteLLM's salt is readable by the
//   LiteLLM container; a compromise there must not also open the app's
//   stored credentials.
// - One key per purpose, derived with HKDF (`info` = purpose). A ciphertext
//   of one kind can't be decrypted as another, and a bug that leaks one
//   derived key leaves the others intact.
// - Bound to its row. The additional authenticated data names the purpose
//   and the owning row (user id, workspace id, …), so a ciphertext copied
//   into another user's row, by SQL injection, a mass-assignment bug or a
//   restore mix-up: fails authentication instead of decrypting for the
//   wrong owner.
//
// Wire format: `v2:<nonce>:<tag>:<ciphertext>` (base64url). The version
// prefix lets a future change migrate rows; anything else is refused.
//
// Rotation: encryption always uses the current key, decryption tries the
// current and then NUXT_ENCRYPTION_KEY_PREVIOUS. `bun run secrets:reencrypt`
// rewrites every row with the current key so the previous one can go
// (the operator runbook, kept outside this repository).

const VERSION = 'v2'
const NONCE_BYTES = 12 // 96-bit random nonce: GCM's native size
const TAG_BYTES = 16
const KEY_BYTES = 32
// Fixed HKDF salt: a domain label, not a secret. Changing it changes every key.
const HKDF_SALT = Buffer.from('markoto/at-rest-secrets', 'utf8')

/** What a ciphertext is; each purpose gets its own derived key. */
export type SecretPurpose
  /** users.litellm_key_token: context: the user id. */
  = | 'litellm-user-key'
  /** workspace_members.litellm_key_token: context: `<workspace id>:<user id>`. */
    | 'litellm-member-key'
  /** user_ai_providers.api_key_encrypted: context: `<user id>:<capability>`. */
    | 'ai-provider-key'
  /** sso_connections.oidc_client_secret: context: the workspace id (unique per connection). */
    | 'sso-client-secret'

/**
 * A stored secret could not be decrypted: wrong key (lost or rotated
 * without `_PREVIOUS`), another row's ciphertext, tampering or an old
 * format. Carries no key material, plaintext or ciphertext. Callers turn
 * it into "re-enter / re-create", never a 500.
 */
export class SecretUnreadableError extends Error {
  readonly purpose: SecretPurpose
  readonly reason: 'format' | 'key-missing' | 'authentication'
  constructor(purpose: SecretPurpose, reason: SecretUnreadableError['reason']) {
    super(`stored ${purpose} can't be decrypted (${reason})`)
    this.name = 'SecretUnreadableError'
    this.purpose = purpose
    this.reason = reason
  }
}

interface KeyMaterial {
  current: string | undefined
  previous: string | undefined
}

function keyMaterial(): KeyMaterial {
  const auth = useEnv().auth
  return { current: auth.encryptionKey || undefined, previous: auth.encryptionKeyPrevious || undefined }
}

function deriveKey(secret: string, purpose: SecretPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), HKDF_SALT, `markoto:${purpose}`, KEY_BYTES))
}

function aad(purpose: SecretPurpose, context: string): Buffer {
  // Length-prefixed so `a:b` + `c` can never equal `a` + `b:c`.
  return Buffer.from(`${VERSION}\u0000${purpose}\u0000${context.length}\u0000${context}`, 'utf8')
}

/** Encrypt `plaintext` for `purpose`, bound to the row named by `context`. */
export function sealSecret(purpose: SecretPurpose, context: string, plaintext: string, material: KeyMaterial = keyMaterial()): string {
  if (!material.current) throw new SecretUnreadableError(purpose, 'key-missing')
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(material.current, purpose), nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(aad(purpose, context))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [VERSION, nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':')
}

function tryOpen(secret: string, purpose: SecretPurpose, context: string, nonce: Buffer, tag: Buffer, ct: Buffer): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, purpose), nonce, { authTagLength: TAG_BYTES })
    decipher.setAAD(aad(purpose, context))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/**
 * Decrypt a value written by `sealSecret` with the same purpose and
 * context. Throws `SecretUnreadableError` (never the underlying crypto
 * error, whose text could carry input) when it can't.
 */
export function openSecret(purpose: SecretPurpose, context: string, sealed: string, material: KeyMaterial = keyMaterial()): string {
  const parts = sealed.split(':')
  const [version, nonceB64, tagB64, ctB64] = parts
  if (parts.length !== 4 || version !== VERSION || nonceB64 === undefined || tagB64 === undefined || ctB64 === undefined) throw new SecretUnreadableError(purpose, 'format')
  const nonce = Buffer.from(nonceB64, 'base64url')
  const tag = Buffer.from(tagB64, 'base64url')
  const ct = Buffer.from(ctB64, 'base64url')
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new SecretUnreadableError(purpose, 'format')
  if (!material.current && !material.previous) throw new SecretUnreadableError(purpose, 'key-missing')
  for (const secret of [material.current, material.previous]) {
    if (!secret) continue
    const plaintext = tryOpen(secret, purpose, context, nonce, tag, ct)
    if (plaintext !== null) return plaintext
  }
  throw new SecretUnreadableError(purpose, 'authentication')
}

/**
 * `openSecret`, or `null` when the value can't be decrypted. For callers
 * whose recovery is "treat as absent" (re-mint a key, ask for it again).
 */
export function openSecretOrNull(purpose: SecretPurpose, context: string, sealed: string): string | null {
  try {
    return openSecret(purpose, context, sealed)
  } catch (e) {
    if (e instanceof SecretUnreadableError) return null
    throw e
  }
}

/** Row contexts, in one place so writers and readers can't drift apart. */
export const secretContext = {
  litellmUserKey: (userId: number): string => String(userId),
  litellmMemberKey: (workspaceId: string, userId: number): string => `${workspaceId}:${userId}`,
  aiProviderKey: (userId: number, capability: string): string => `${userId}:${capability}`,
  ssoClientSecret: (workspaceId: string): string => workspaceId
}
