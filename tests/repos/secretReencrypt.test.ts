import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace } from '../integration/setup/fixtures'
import { openSecret, openSecretOrNull, sealSecret, secretContext } from '../../server/utils/platform/secretBox'
import { reencryptStoredSecrets } from '../../server/utils/platform/secretReencrypt'
import { stubEnv } from '../helpers/env'

// Rotating NUXT_ENCRYPTION_KEY: after the re-encryption run every stored
// secret opens with the new key alone, so _PREVIOUS can be removed.

const OLD = 'old-encryption-key-0000000000000000000000'
const NEW = 'new-encryption-key-1111111111111111111111'

beforeEach(async () => {
  await resetDb()
})
afterEach(() => vi.unstubAllEnvs())

describe('reencryptStoredSecrets', () => {
  it('rewrites every stored secret with the current key and reports unreadable rows', async () => {
    const db = testDb()
    const u = await createUser()
    const ws = await createWorkspace(u.id)

    stubEnv({ NUXT_ENCRYPTION_KEY: OLD })
    await db.query('UPDATE users SET litellm_key_id = $1, litellm_key_token = $2 WHERE id = $3',
      ['kid-1', sealSecret('litellm-user-key', secretContext.litellmUserKey(u.id), 'sk-user-token'), u.id])
    await db.query('UPDATE workspace_members SET litellm_key_id = $1, litellm_key_token = $2 WHERE workspace_id = $3 AND user_id = $4',
      ['kid-2', sealSecret('litellm-member-key', secretContext.litellmMemberKey(ws.workspaceId, u.id), 'sk-member-token'), ws.workspaceId, u.id])
    await db.query(`INSERT INTO user_ai_providers (user_id, capability, base_url, model, api_key_encrypted, api_key_last4, supports_vision)
      VALUES ($1, 'chat', 'https://api.example.org/v1', 'm', $2, '1234', false)`,
    [u.id, sealSecret('ai-provider-key', secretContext.aiProviderKey(u.id, 'chat'), 'sk-provider-key')])
    // A row no key can read (written under another key altogether).
    stubEnv({ NUXT_ENCRYPTION_KEY: 'some-lost-key-222222222222222222222222' })
    await db.query(`INSERT INTO user_ai_providers (user_id, capability, base_url, model, api_key_encrypted, api_key_last4, supports_vision)
      VALUES ($1, 'image', 'https://api.example.org/v1', 'm', $2, '1234', false)`,
    [u.id, sealSecret('ai-provider-key', secretContext.aiProviderKey(u.id, 'image'), 'lost')])

    stubEnv({ NUXT_ENCRYPTION_KEY: NEW, NUXT_ENCRYPTION_KEY_PREVIOUS: OLD })
    const dry = await reencryptStoredSecrets(db, { dryRun: true })
    expect(dry.rewritten).toBe(3)
    const summary = await reencryptStoredSecrets(db)
    expect(summary.rewritten).toBe(3)
    expect(summary.unreadable).toEqual([{ purpose: 'ai-provider-key', row: `${u.id}:image` }])

    stubEnv({ NUXT_ENCRYPTION_KEY: NEW, NUXT_ENCRYPTION_KEY_PREVIOUS: undefined })
    const user = (await db.query('SELECT litellm_key_token FROM users WHERE id = $1', [u.id])).rows[0]
    expect(openSecret('litellm-user-key', secretContext.litellmUserKey(u.id), user.litellm_key_token)).toBe('sk-user-token')
    const member = (await db.query('SELECT litellm_key_token FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws.workspaceId, u.id])).rows[0]
    expect(openSecret('litellm-member-key', secretContext.litellmMemberKey(ws.workspaceId, u.id), member.litellm_key_token)).toBe('sk-member-token')
    const providers = (await db.query('SELECT capability, api_key_encrypted FROM user_ai_providers WHERE user_id = $1 ORDER BY capability', [u.id])).rows
    expect(openSecret('ai-provider-key', secretContext.aiProviderKey(u.id, 'chat'), providers[0].api_key_encrypted)).toBe('sk-provider-key')
    expect(openSecretOrNull('ai-provider-key', secretContext.aiProviderKey(u.id, 'image'), providers[1].api_key_encrypted)).toBeNull()
  })
})
