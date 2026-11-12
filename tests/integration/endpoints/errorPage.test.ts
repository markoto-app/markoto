import { describe, it, expect } from 'vitest'
import { anonClient } from '../setup/client'

// server/error.ts replaces Nuxt's own error handler, which is what renders
// app/error.vue. A browser opening an unknown address must still get that
// page; API clients keep the JSON payload.

describe('unknown page', () => {
  it('a browser request gets the app\'s error page with status 404', async () => {
    const res = await anonClient().get('/this-page-does-not-exist', { headers: { accept: 'text/html,application/xhtml+xml' } })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()
    expect(html).toContain('data-testid="error-page"')
  })

  it('a request that does not ask for HTML keeps the JSON payload', async () => {
    const res = await anonClient().get('/this-page-does-not-exist', { headers: { accept: 'application/json' } })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect((await res.json() as { statusCode: number }).statusCode).toBe(404)
  })

  it('an unknown API route answers JSON even to a browser', async () => {
    const res = await anonClient().get('/api/health/does-not-exist', { headers: { accept: 'text/html' } })
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
  })
})
