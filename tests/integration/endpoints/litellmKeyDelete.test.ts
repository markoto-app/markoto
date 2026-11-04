import { describe, it, expect } from 'vitest'
import { deleteLitellmIdentity } from '../../../server/utils/litellm/userKeys'
import { LITELLM_URL, LITELLM_MASTER_KEY } from '../setup/byok'

// The account-deletion step against the real `litellm-test` proxy: after
// `deleteLitellmIdentity` runs, the user's virtual key and LiteLLM user
// record must be gone. The integration server runs with
// LITELLM_TEST_STUB=1, so this drives the HTTP half directly with the
// proxy's master key instead of going through the app.

function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${LITELLM_URL}${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${LITELLM_MASTER_KEY}`, 'Content-Type': 'application/json' }
  })
}

describe('deleteLitellmIdentity wire contract', () => {
  it('removes the virtual key and the LiteLLM user', async () => {
    const userId = 900000 + Math.floor(Math.random() * 99999)
    const gen = await adminFetch('/key/generate', {
      method: 'POST',
      body: JSON.stringify({ max_budget: 1, user_id: String(userId) })
    })
    expect(gen.status).toBe(200)
    const { key } = await gen.json() as { key: string }
    const before = await fetch(`${LITELLM_URL}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })
    expect(before.status).toBe(200)

    expect(await deleteLitellmIdentity(adminFetch, key, userId)).toBe(true)

    // The deleted key no longer authenticates. (`/key/info` keeps
    // answering from LiteLLM's in-memory cache for a while, so it is not
    // a usable signal.)
    const asKey = await fetch(`${LITELLM_URL}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })
    expect(asKey.status).toBe(401)
    const userInfo = await adminFetch(`/user/info?user_id=${userId}`)
    if (userInfo.status === 200) {
      const body = await userInfo.json() as { user_info?: unknown, keys?: unknown[] }
      expect(body.keys ?? []).toHaveLength(0)
      expect(body.user_info ?? null).toBeNull()
    }
  })

  it('treats a user that never had a key as done', async () => {
    const userId = 900000 + Math.floor(Math.random() * 99999)
    expect(await deleteLitellmIdentity(adminFetch, null, userId)).toBe(true)
  })
})
