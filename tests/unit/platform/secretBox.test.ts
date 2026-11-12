import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSecret, openSecretOrNull, sealSecret, secretContext, SecretUnreadableError, type SecretPurpose } from '../../../server/utils/platform/secretBox'
import { stubEnv } from '../../helpers/env'

// At-rest encryption of stored secrets: per-purpose keys (HKDF), ciphertexts
// bound to their row (AAD), rotation through NUXT_ENCRYPTION_KEY_PREVIOUS,
// and failures that carry nothing secret.

const KEY_A = 'a'.repeat(32) + '-current-encryption-key'
const KEY_B = 'b'.repeat(32) + '-next-encryption-key'
const PLAINTEXT = 'sk-very-secret-provider-key-1234'

const PURPOSES: SecretPurpose[] = ['litellm-user-key', 'litellm-member-key', 'ai-provider-key', 'sso-client-secret']

afterEach(() => vi.unstubAllEnvs())

function catchError(fn: () => unknown): Error {
  try {
    fn()
  } catch (e) {
    return e as Error
  }
  throw new Error('expected a throw')
}

describe('secretBox', () => {
  it('round-trips for every purpose', () => {
    stubEnv({ NUXT_ENCRYPTION_KEY: KEY_A })
    for (const purpose of PURPOSES) {
      const sealed = sealSecret(purpose, 'row-1', PLAINTEXT)
      expect(sealed).toMatch(/^v2:[\w-]+:[\w-]+:[\w-]+$/)
      expect(sealed).not.toContain(PLAINTEXT)
      expect(openSecret(purpose, 'row-1', sealed)).toBe(PLAINTEXT)
    }
  })

  it('refuses a ciphertext opened under another purpose (own key per purpose)', () => {
    stubEnv({ NUXT_ENCRYPTION_KEY: KEY_A })
    const sealed = sealSecret('ai-provider-key', secretContext.aiProviderKey(7, 'chat'), PLAINTEXT)
    expect(() => openSecret('litellm-user-key', secretContext.aiProviderKey(7, 'chat'), sealed)).toThrow(SecretUnreadableError)
    expect(() => openSecret('sso-client-secret', secretContext.aiProviderKey(7, 'chat'), sealed)).toThrow(SecretUnreadableError)
  })

  it('refuses a ciphertext copied into another row (AAD binds the owner)', () => {
    stubEnv({ NUXT_ENCRYPTION_KEY: KEY_A })
    const alice = sealSecret('ai-provider-key', secretContext.aiProviderKey(1, 'chat'), PLAINTEXT)
    expect(() => openSecret('ai-provider-key', secretContext.aiProviderKey(2, 'chat'), alice)).toThrow(SecretUnreadableError)
    expect(() => openSecret('ai-provider-key', secretContext.aiProviderKey(1, 'image'), alice)).toThrow(SecretUnreadableError)
    const member = sealSecret('litellm-member-key', secretContext.litellmMemberKey('ws1', 5), PLAINTEXT)
    expect(() => openSecret('litellm-member-key', secretContext.litellmMemberKey('ws2', 5), member)).toThrow(SecretUnreadableError)
    expect(openSecretOrNull('litellm-member-key', secretContext.litellmMemberKey('ws1', 6), member)).toBeNull()
  })

  it('does not confuse contexts whose concatenation is equal', () => {
    stubEnv({ NUXT_ENCRYPTION_KEY: KEY_A })
    const sealed = sealSecret('litellm-member-key', 'ab:1', PLAINTEXT)
    expect(() => openSecret('litellm-member-key', 'a:b1', sealed)).toThrow(SecretUnreadableError)
  })

  it('detects tampering with nonce, tag or ciphertext', () => {
    stubEnv({ NUXT_ENCRYPTION_KEY: KEY_A })
    const sealed = sealSecret('litellm-user-key', '1', PLAINTEXT)
    const parts = sealed.split(':')
    for (const i of [1, 2, 3]) {
      const bytes = Buffer.from(parts[i]!, 'base64url')
      bytes[0] = bytes[0]! ^ 0x01
      const tampered = [...parts]
      tampered[i] = bytes.toString('base64url')
      const err = catchError(() => openSecret('litellm-user-key', '1', tampered.join(':')))
      expect(err).toBeInstanceOf(SecretUnreadableError)
    }
  })

  it('refuses the old v1 format and garbage with a clean error', () => {
    stubEnv({ NUXT_ENCRYPTION_KEY: KEY_A })
    for (const bad of ['v1:aaaa:bbbb:cccc', 'nonsense', '', 'v2:a:b']) {
      const err = catchError(() => openSecret('litellm-user-key', '1', bad))
      expect(err).toBeInstanceOf(SecretUnreadableError)
      expect((err as SecretUnreadableError).reason).toBe('format')
    }
  })

  it('decrypts with NUXT_ENCRYPTION_KEY_PREVIOUS during a rotation and encrypts with the current key', () => {
    stubEnv({ NUXT_ENCRYPTION_KEY: KEY_A })
    const old = sealSecret('sso-client-secret', 'ws1', PLAINTEXT)

    stubEnv({ NUXT_ENCRYPTION_KEY: KEY_B, NUXT_ENCRYPTION_KEY_PREVIOUS: KEY_A })
    expect(openSecret('sso-client-secret', 'ws1', old)).toBe(PLAINTEXT)
    const fresh = sealSecret('sso-client-secret', 'ws1', PLAINTEXT)

    // Without the previous key the old ciphertext is gone, the new one isn't.
    stubEnv({ NUXT_ENCRYPTION_KEY: KEY_B, NUXT_ENCRYPTION_KEY_PREVIOUS: undefined })
    expect(openSecretOrNull('sso-client-secret', 'ws1', old)).toBeNull()
    expect(openSecret('sso-client-secret', 'ws1', fresh)).toBe(PLAINTEXT)
  })

  it('refuses to encrypt without a key instead of using a default', () => {
    stubEnv({ NUXT_ENCRYPTION_KEY: undefined, NUXT_ENCRYPTION_KEY_PREVIOUS: undefined })
    const err = catchError(() => sealSecret('litellm-user-key', '1', PLAINTEXT))
    expect(err).toBeInstanceOf(SecretUnreadableError)
    expect((err as SecretUnreadableError).reason).toBe('key-missing')
  })

  it('uses a fresh random 96-bit nonce per encryption', () => {
    stubEnv({ NUXT_ENCRYPTION_KEY: KEY_A })
    const nonces = new Set<string>()
    const ciphertexts = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const [, nonce, , ct] = sealSecret('litellm-user-key', '1', PLAINTEXT).split(':')
      expect(Buffer.from(nonce!, 'base64url')).toHaveLength(12)
      nonces.add(nonce!)
      ciphertexts.add(ct!)
    }
    expect(nonces.size).toBe(500)
    expect(ciphertexts.size).toBe(500)
  })

  it('never puts a key, the plaintext or the ciphertext into an error', () => {
    stubEnv({ NUXT_ENCRYPTION_KEY: KEY_A })
    const sealed = sealSecret('ai-provider-key', '1:chat', PLAINTEXT)
    stubEnv({ NUXT_ENCRYPTION_KEY: KEY_B })
    const err = catchError(() => openSecret('ai-provider-key', '1:chat', sealed))
    const text = `${err.message} ${err.stack ?? ''} ${JSON.stringify(err)}`
    for (const secret of [KEY_A, KEY_B, PLAINTEXT, ...sealed.split(':').slice(1)]) {
      expect(text).not.toContain(secret)
    }
    expect(err.cause).toBeUndefined()
  })
})
