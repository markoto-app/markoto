// @vitest-environment jsdom
//
// The browser Sentry SDK must hand every error, sampled transaction and
// breadcrumb to the shared scrubber: fetch breadcrumbs carry presigned S3
// URLs and navigation breadcrumbs carry invite / render tokens in the query.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

interface InitOptions {
  sendDefaultPii?: boolean
  beforeSend: (event: unknown) => unknown
  beforeSendTransaction: (event: unknown) => unknown
  beforeBreadcrumb: (crumb: unknown) => unknown
  integrations: (defaults: Array<{ name: string }>) => Array<{ name: string }>
}

const init = vi.hoisted(() => vi.fn<(options: InitOptions) => void>())

vi.mock('@sentry/nuxt', () => ({
  init,
  captureException: vi.fn(),
  setUser: vi.fn(),
  browserTracingIntegration: () => ({ name: 'BrowserTracing' })
}))

async function startAndGetOptions(): Promise<InitOptions> {
  const { startSentry } = await import('../../app/utils/platform/sentryClient')
  startSentry({ dsn: 'https://key@example.invalid/1', router: Object.create(null), production: true })
  expect(init).toHaveBeenCalledOnce()
  const options = init.mock.calls[0]?.[0]
  if (!options) throw new Error('Sentry init was not called')
  return options
}

describe('browser Sentry init', () => {
  beforeEach(() => init.mockClear())
  afterEach(() => vi.resetModules())

  test('turns default PII off and enables no replay or feedback integration', async () => {
    const options = await startAndGetOptions()
    expect(options.sendDefaultPii).toBe(false)
    const names = options.integrations([{ name: 'Breadcrumbs' }, { name: 'GlobalHandlers' }]).map(i => i.name)
    expect(names).toEqual(['Breadcrumbs', 'BrowserTracing'])
    expect(names.some(n => /replay|feedback/i.test(n))).toBe(false)
  })

  test('navigation breadcrumbs lose the query string with the token', async () => {
    const options = await startAndGetOptions()
    const crumb = options.beforeBreadcrumb({
      category: 'navigation',
      data: { from: '/d/abc?t=render-token-123', to: '/invite/accept?token=secret-invite-token' }
    }) as { data: { from: string, to: string } }
    expect(crumb.data.from).toBe('/d/abc')
    expect(crumb.data.to).toBe('/invite/accept')
    expect(JSON.stringify(crumb)).not.toMatch(/secret-invite-token|render-token-123/)
  })

  test('fetch breadcrumbs lose the presigned S3 signature', async () => {
    const options = await startAndGetOptions()
    const url = 'https://s3.example.org/bucket/docs/d1/f1.png?X-Amz-Credential=AKIA%2F2026&X-Amz-Signature=deadbeefcafe&X-Amz-Expires=120'
    const crumb = options.beforeBreadcrumb({
      category: 'fetch',
      data: { url, method: 'GET', status_code: 200 }
    }) as { data: { url: string } }
    expect(crumb.data.url).toBe('https://s3.example.org/bucket/docs/d1/f1.png')
    expect(JSON.stringify(crumb)).not.toMatch(/deadbeefcafe|AKIA/)
  })

  test('error events drop cookies, bodies and emails in messages; transactions get the same pass', async () => {
    const options = await startAndGetOptions()
    const event = {
      message: 'failed for jane.doe@example.org at https://app.example/p?token=abc12345',
      request: {
        url: 'https://app.example/d/1?token=abc12345',
        headers: { 'cookie': 'session=1', 'authorization': 'Bearer xyz', 'user-agent': 'ua' },
        data: { body: 'document text' }
      }
    }
    const out = options.beforeSend(event) as typeof event & { request: { headers: Record<string, string>, data?: unknown } }
    expect(out.message).not.toContain('jane.doe@')
    expect(out.message).not.toContain('abc12345')
    expect(out.request.headers).toEqual({ 'user-agent': 'ua' })
    expect(out.request.data).toBeUndefined()

    const tx = options.beforeSendTransaction({ transaction: '/d/1?token=abc12345', type: 'transaction' }) as { transaction: string }
    expect(tx.transaction).toBe('/d/1')
  })
})
