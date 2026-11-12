import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser } from '../integration/setup/fixtures'
import { sealProviderKey } from '../../server/utils/aiProviders/keyCrypto'
import {
  deleteAllAiProvidersForUser,
  deleteAiProvider,
  getAiProvider,
  listAiProviders,
  markAiProviderVerified,
  upsertAiProvider,
  type AiProviderUpsert
} from '../../server/repos/aiProviders'
import { availabilityFrom, resolveAiAccess, resolveAiProviders } from '../../server/utils/aiProviders/resolve'
import { requireAiProviders } from '../../server/utils/aiProviders/guard'
import { toProviderView } from '../../server/utils/aiProviders/store'
import { asUser, sys } from '../helpers/access'

// Bring-your-own-key provider configs: repo CRUD, resolution order
// (own key → instance default → none), key-free views, GDPR export and
// account deletion.

// Same stub as dataExport.test.ts (the repos project shares one module
// registry, `isolate: false`, so mocks of shared modules must agree).
vi.mock('../../server/utils/billing/stripeClient', () => ({ useStripeClient: () => null }))
const { buildExportZip } = await import('../../server/utils/privacy/dataExport')

const SECRET = 'sk-user-secret-key-1234567890'

function row(userId: number, over: Partial<AiProviderUpsert> = {}): AiProviderUpsert {
  return {
    capability: 'chat',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-2603',
    apiKeyEncrypted: sealProviderKey(userId, over.capability ?? 'chat', SECRET),
    apiKeyLast4: '7890',
    supportsVision: true,
    supportsTools: true,
    lastVerifiedAt: new Date(),
    ...over
  }
}

const DEFAULT_ENV_KEYS = [
  'NUXT_AI_DEFAULT_CHAT_MODEL', 'NUXT_AI_DEFAULT_CHAT_BASE_URL', 'NUXT_AI_DEFAULT_CHAT_API_KEY',
  'NUXT_AI_DEFAULT_IMAGE_MODEL', 'NUXT_AI_DEFAULT_TRANSCRIBE_MODEL', 'MISTRAL_API_KEY'
]

describe('user_ai_providers repo', () => {
  beforeEach(async () => {
    await resetDb()
    for (const k of DEFAULT_ENV_KEYS) vi.stubEnv(k, '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('upsert creates then replaces the single row per (user, capability)', async () => {
    const u = await createUser()
    await upsertAiProvider(asUser(u.id), row(u.id))
    await upsertAiProvider(asUser(u.id), row(u.id, { model: 'ministral-8b-2512' }))
    const all = await listAiProviders(asUser(u.id))
    expect(all).toHaveLength(1)
    expect(all[0]?.model).toBe('ministral-8b-2512')
  })

  it('stores the key encrypted, never in plaintext', async () => {
    const u = await createUser()
    await upsertAiProvider(asUser(u.id), row(u.id))
    const raw = await testDb().query<{ api_key_encrypted: string }>('SELECT api_key_encrypted FROM user_ai_providers')
    expect(raw.rows[0]?.api_key_encrypted).toMatch(/^v2:/)
    expect(raw.rows[0]?.api_key_encrypted).not.toContain(SECRET)
  })

  it('the client view carries host + last four only', async () => {
    const u = await createUser()
    const saved = await upsertAiProvider(asUser(u.id), row(u.id))
    const view = toProviderView(saved)
    expect(view).toMatchObject({ capability: 'chat', host: 'api.mistral.ai', model: 'mistral-small-2603', apiKeyLast4: '7890' })
    expect(JSON.stringify(view)).not.toContain(SECRET)
    expect(JSON.stringify(view)).not.toContain('v1:')
  })

  it('markVerified + delete', async () => {
    const u = await createUser()
    await upsertAiProvider(asUser(u.id), row(u.id, { supportsTools: null, lastVerifiedAt: null }))
    await markAiProviderVerified(asUser(u.id), 'chat', { supportsTools: false, verifiedAt: new Date() })
    const after = await getAiProvider(asUser(u.id), 'chat')
    expect(after?.supportsTools).toBe(false)
    expect(after?.lastVerifiedAt).not.toBeNull()
    expect(await deleteAiProvider(asUser(u.id), 'chat')).toBe(true)
    expect(await deleteAiProvider(asUser(u.id), 'chat')).toBe(false)
  })

  it('rows are per user (no cross-user reads)', async () => {
    const a = await createUser()
    const b = await createUser()
    await upsertAiProvider(asUser(a.id), row(a.id))
    expect(await getAiProvider(asUser(b.id), 'chat')).toBeNull()
  })
})

describe('resolution order: own key → instance default → unavailable', () => {
  beforeEach(async () => {
    await resetDb()
    for (const k of DEFAULT_ENV_KEYS) vi.stubEnv(k, '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('nothing configured → every capability unavailable', async () => {
    const u = await createUser()
    const p = await resolveAiProviders(asUser(u.id), 'free')
    expect(p).toEqual({ chat: null, image: null, transcription: null })
    const a = availabilityFrom(p)
    expect(a.chat).toMatchObject({ available: false, source: 'none', platformBilled: false })
    expect(a.transcription.liveDictation).toBe(false)
  })

  it('instance alias default → platform-billed, no credentials', async () => {
    vi.stubEnv('NUXT_AI_DEFAULT_CHAT_MODEL', 'mistral-small-2603')
    const u = await createUser()
    const p = await resolveAiProviders(asUser(u.id), 'free')
    expect(p.chat).toMatchObject({ source: 'instance', model: 'mistral-small-2603', credentials: null })
    expect(availabilityFrom(p).chat).toMatchObject({ available: true, source: 'instance', platformBilled: true })
  })

  it('the user\'s own key wins over the instance default and is not platform-billed', async () => {
    vi.stubEnv('NUXT_AI_DEFAULT_CHAT_MODEL', 'mistral-small-2603')
    const u = await createUser()
    await upsertAiProvider(asUser(u.id), row(u.id, { model: 'gpt-5.4-mini', baseUrl: 'https://api.openai.com/v1' }))
    const p = await resolveAiProviders(asUser(u.id), 'free')
    expect(p.chat).toMatchObject({ source: 'user', model: 'gpt-5.4-mini', credentials: { baseUrl: 'https://api.openai.com/v1', apiKey: SECRET } })
    expect(availabilityFrom(p).chat.platformBilled).toBe(false)
  })

  it('an undecryptable stored key falls back to the instance default', async () => {
    vi.stubEnv('NUXT_AI_DEFAULT_CHAT_MODEL', 'mistral-small-2603')
    const u = await createUser()
    await upsertAiProvider(asUser(u.id), row(u.id, { apiKeyEncrypted: 'v1:broken:broken:broken' }))
    const p = await resolveAiProviders(asUser(u.id), 'free')
    expect(p.chat?.source).toBe('instance')
  })

  it('a key copied from another user\'s row does not decrypt for this user', async () => {
    vi.stubEnv('NUXT_AI_DEFAULT_CHAT_MODEL', 'mistral-small-2603')
    const alice = await createUser()
    const mallory = await createUser()
    await upsertAiProvider(asUser(alice.id), row(alice.id))
    const stolen = (await getAiProvider(asUser(alice.id), 'chat'))!.apiKeyEncrypted
    await upsertAiProvider(asUser(mallory.id), row(mallory.id, { apiKeyEncrypted: stolen }))
    expect((await resolveAiProviders(asUser(alice.id), 'free')).chat?.credentials?.apiKey).toBe(SECRET)
    expect((await resolveAiProviders(asUser(mallory.id), 'free')).chat?.source).toBe('instance')
  })

  it('live dictation: own Mistral transcription key → available, not platform-billed', async () => {
    const u = await createUser()
    await upsertAiProvider(asUser(u.id), row(u.id, { capability: 'transcription', model: 'voxtral-mini-2602', supportsVision: false }))
    const a = availabilityFrom(await resolveAiProviders(asUser(u.id), 'free'))
    expect(a.transcription).toMatchObject({ available: true, source: 'user', liveDictation: true })
  })

  it('live dictation: a non-Mistral transcription key → transcription yes, dictation no', async () => {
    const u = await createUser()
    await upsertAiProvider(asUser(u.id), row(u.id, { capability: 'transcription', model: 'whisper-1', baseUrl: 'https://api.openai.com/v1' }))
    const a = availabilityFrom(await resolveAiProviders(asUser(u.id), 'free'))
    expect(a.transcription).toMatchObject({ available: true, liveDictation: false })
  })

  it('live dictation on an alias default needs the operator MISTRAL_API_KEY', async () => {
    vi.stubEnv('NUXT_AI_DEFAULT_TRANSCRIBE_MODEL', 'voxtral-mini-transcribe')
    const u = await createUser()
    expect(availabilityFrom(await resolveAiProviders(asUser(u.id), 'free')).transcription.liveDictation).toBe(false)
    vi.stubEnv('MISTRAL_API_KEY', 'operator-key')
    expect(availabilityFrom(await resolveAiProviders(asUser(u.id), 'free')).transcription.liveDictation).toBe(true)
  })
})

describe('AI by plan', () => {
  beforeEach(async () => {
    await resetDb()
    for (const k of DEFAULT_ENV_KEYS) vi.stubEnv(k, '')
    vi.stubEnv('NUXT_AI_DEFAULT_CHAT_MODEL', 'zai-glm-5-3-flash')
    vi.stubEnv('NUXT_AI_DEFAULT_CHAT_STRONG_MODEL', 'mistral-small-2603')
    vi.stubEnv('NUXT_AI_DEFAULT_IMAGE_MODEL', 'flux-2-pro')
    vi.stubEnv('NUXT_AI_DEFAULT_TRANSCRIBE_MODEL', 'voxtral-mini-transcribe')
    // The hosted free tier: image, voice and the strong model off.
    vi.stubEnv('TIER_FREE_FEATURE_AI_IMAGE', 'false')
    vi.stubEnv('TIER_FREE_FEATURE_AI_VOICE', 'false')
    vi.stubEnv('TIER_FREE_FEATURE_AI_STRONG_MODEL', 'false')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('a plan without image / voice gets no platform default for them — locked, not missing', async () => {
    const u = await createUser()
    const access = await resolveAiAccess(asUser(u.id), 'free')
    expect(access.providers.chat?.model).toBe('zai-glm-5-3-flash')
    expect(access.providers.image).toBeNull()
    expect(access.providers.transcription).toBeNull()
    expect(access.locked.sort()).toEqual(['image', 'transcription'])
    const a = availabilityFrom(access.providers, access)
    expect(a.image).toMatchObject({ available: false, locked: 'plan' })
    expect(a.chat.locked).toBeUndefined()
    vi.stubGlobal('createError', (input: Record<string, unknown>) => Object.assign(new Error(String(input.message)), input))
    try {
      await expect(requireAiProviders(asUser(u.id), 'transcription', 'free')).rejects.toMatchObject({ statusCode: 409, data: { code: 'plan/feature-unavailable', feature: 'aiVoice' } })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('Pro unlocks them; an own key unlocks them on any plan', async () => {
    const u = await createUser()
    const pro = await resolveAiAccess(asUser(u.id), 'pro')
    expect(pro.providers.image?.model).toBe('flux-2-pro')
    expect(pro.locked).toEqual([])
    await upsertAiProvider(asUser(u.id), row(u.id, { capability: 'image', model: 'gpt-image-1', baseUrl: 'https://api.openai.com/v1', supportsVision: false }))
    const free = await resolveAiAccess(asUser(u.id), 'free')
    expect(free.providers.image?.source).toBe('user')
    expect(free.locked).toEqual(['transcription'])
  })

  it('"Strong" uses the strong model only where the plan includes it', async () => {
    const u = await createUser()
    await testDb().query(`UPDATE users SET ai_model_tier = 'strong' WHERE id = $1`, [u.id])
    const free = await resolveAiAccess(asUser(u.id), 'free')
    expect(free.providers.chat?.model).toBe('zai-glm-5-3-flash')
    expect(free.modelTier).toEqual({ selected: 'strong', strongAvailable: true, strongLocked: true })
    const pro = await resolveAiAccess(asUser(u.id), 'pro')
    expect(pro.providers.chat?.model).toBe('mistral-small-2603')
    expect(pro.modelTier.strongLocked).toBe(false)
  })

  it('an own chat key is never swapped for the strong model', async () => {
    const u = await createUser()
    await testDb().query(`UPDATE users SET ai_model_tier = 'strong' WHERE id = $1`, [u.id])
    await upsertAiProvider(asUser(u.id), row(u.id, { model: 'gpt-5.4-mini', baseUrl: 'https://api.openai.com/v1' }))
    const pro = await resolveAiAccess(asUser(u.id), 'pro')
    expect(pro.providers.chat?.model).toBe('gpt-5.4-mini')
    expect(pro.modelTier.strongAvailable).toBe(false)
  })
})

describe('GDPR: export + account deletion', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('the export lists provider settings WITHOUT any key material', async () => {
    const u = await createUser()
    await upsertAiProvider(asUser(u.id), row(u.id))
    const zip = await buildExportZip(sys(), u.id)
    const entries = unzipSync(zip.bytes)
    const text = strFromU8(entries['ai/providers.json'] ?? new Uint8Array())
    const parsed = JSON.parse(text)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ capability: 'chat', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-2603' })
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('7890')
    expect(text).not.toContain('v1:')
    expect(zip.counts.aiProviders).toBe(1)
  })

  // The executor step itself is pinned in accountDeletionExecute.test.ts
  // (summary.aiProvidersDeleted); here: the repo primitive + the FK
  // cascade backstop.
  it('deleteAllAiProvidersForUser removes every config of that user only', async () => {
    const u = await createUser()
    const other = await createUser()
    await upsertAiProvider(asUser(u.id), row(u.id))
    await upsertAiProvider(asUser(u.id), row(u.id, { capability: 'image', model: 'gpt-image-1', baseUrl: 'https://api.openai.com/v1' }))
    await upsertAiProvider(asUser(other.id), row(other.id))
    expect(await deleteAllAiProvidersForUser(asUser(u.id))).toBe(2)
    expect(await listAiProviders(asUser(u.id))).toHaveLength(0)
    expect(await listAiProviders(asUser(other.id))).toHaveLength(1)
  })

  it('deleting the user row cascades to the configs', async () => {
    const u = await createUser()
    await upsertAiProvider(asUser(u.id), row(u.id))
    await testDb().query('DELETE FROM users WHERE id = $1', [u.id])
    const left = await testDb().query('SELECT 1 FROM user_ai_providers WHERE user_id = $1', [u.id])
    expect(left.rowCount).toBe(0)
  })
})
