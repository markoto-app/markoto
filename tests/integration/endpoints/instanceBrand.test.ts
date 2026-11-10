import { describe, expect, it } from 'vitest'
import { anonClient } from '../setup/client'
import { TEST_INSTANCE_BRAND_NAME } from '../setup/env'

// Co-branding of a managed private instance (WP16): the primary test
// server is configured with a customer name, logo and support address.

describe('instance co-branding', () => {
  it('serves the configured logo, nothing else, under a sandbox CSP', async () => {
    const logo = await anonClient().get('/instance-brand/logo.png')
    expect(logo.status).toBe(200)
    expect(logo.headers.get('content-type')).toBe('image/png')
    expect(logo.headers.get('content-security-policy')).toContain('sandbox')
    expect((await logo.arrayBuffer()).byteLength).toBeGreaterThan(100)
    for (const other of ['/instance-brand/logo.svg', '/instance-brand/other.png', '/instance-brand/..%2F.env']) {
      expect((await anonClient().get(other)).status, other).toBe(404)
    }
  })

  it('pages carry the brand next to the wordmark and in the title', async () => {
    const html = await (await anonClient().get('/legal/sub-processors')).text()
    expect(html).toContain('data-testid="instance-brand"')
    expect(html).toContain('src="/instance-brand/logo.png"')
    expect(html).toContain(TEST_INSTANCE_BRAND_NAME)
    expect(html).toMatch(new RegExp(`<title>[^<]*· markoto · ${TEST_INSTANCE_BRAND_NAME}</title>`))
  })
})
