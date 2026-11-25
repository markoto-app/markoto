import { describe, expect, it } from 'vitest'
import { TEST_BASE_URL } from '../setup/env'

// `/settings` has no page of its own: the server render redirects to the
// first settings page (signed in or not; the profile page itself sends a
// signed-out visitor on to sign in).

describe('GET /settings', () => {
  it('redirects to /settings/profile', async () => {
    const res = await fetch(`${TEST_BASE_URL}/settings`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location') ?? '', TEST_BASE_URL).pathname).toBe('/settings/profile')
  })

  it('keeps the query string', async () => {
    const res = await fetch(`${TEST_BASE_URL}/settings?from=menu`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const target = new URL(res.headers.get('location') ?? '', TEST_BASE_URL)
    expect(target.pathname + target.search).toBe('/settings/profile?from=menu')
  })
})
