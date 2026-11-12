import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scrubBreadcrumb, scrubEvent, scrubUrl, sentryScrubOptions } from '../../../shared/utils/security/sentryScrub'

// What reaches Sentry from the app, the sync server and the renderer: no
// credentials in URLs, no bodies or cookies, only allowlisted headers, no
// secrets by key, no emails, bounded strings, in errors, sampled
// transactions and breadcrumbs alike.

const PRESIGNED = 'https://s3.gra.io.cloud.ovh.net/markoto/docs/abc/file.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20261112&X-Amz-Signature=deadbeefcafebabe0123456789&X-Amz-Expires=120'
const RENDER_URL = 'http://markoto-app:3000/_internal/render/doc123?t=eyJhbGciOiJIUzI1NiJ9.eyJkb2NJZCI6ImRvYzEyMyJ9.c2lnbmF0dXJlLXZhbHVl&format=pdf'
const JWT_PART = 'eyJkb2NJZCI6ImRvYzEyMyJ9'
const BEARER = 'sk-live-abcdefghijklmnopqrstuvwxyz123456'
const EMAIL = 'jane.doe@example.org'

function json(value: unknown): string {
  return JSON.stringify(value)
}

function expectClean(value: unknown): void {
  const text = json(value)
  for (const leak of ['X-Amz-Signature=dead', 'AKIAEXAMPLE', JWT_PART, BEARER, EMAIL, 't=eyJ', 'whsec_', 'session=abc', 'super-internal', 'v1=5257a869']) {
    expect(text, leak).not.toContain(leak)
  }
}

describe('sentry scrubber', () => {
  it('strips query strings, fragments and credentials from URLs', () => {
    expect(scrubUrl(PRESIGNED)).toBe('https://s3.gra.io.cloud.ovh.net/markoto/docs/abc/file.png')
    expect(scrubUrl(RENDER_URL)).toBe('http://markoto-app:3000/_internal/render/doc123')
    expect(scrubUrl('https://user:pw@host/p#frag')).toBe('https://host/p')
  })

  it('scrubs a Stripe webhook error event: body, signature header, cookies, query, user PII', () => {
    const event = {
      message: `Webhook failed for ${EMAIL}`,
      request: {
        method: 'POST',
        url: 'https://markoto.app/api/webhooks/stripe?token=abc123secret',
        query_string: 'token=abc123secret',
        data: '{"customer_email":"jane.doe@example.org","whsec_":"x"}',
        cookies: { 'nuxt-session': 'session=abc' },
        env: { NUXT_STRIPE_WEBHOOK_SECRET: 'whsec_123' },
        headers: {
          'stripe-signature': 't=1700000000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd',
          'authorization': `Bearer ${BEARER}`,
          'cookie': 'session=abc',
          'x-internal-secret': 'super-internal',
          'content-type': 'application/json',
          'user-agent': 'Stripe/1.0'
        }
      },
      user: { id: 42, email: EMAIL, ip_address: '203.0.113.9', username: 'jane' },
      extra: { apiKey: BEARER, nested: { refreshToken: 'abc', note: `contact ${EMAIL}` }, ok: 7 },
      contexts: { response: { headers: { 'set-cookie': 'session=abc' } }, trace: { trace_id: 'ab12', data: { 'url.query': 'X-Amz-Signature=deadbeef', 'http.url': PRESIGNED } } },
      tags: { password: 'hunter2', route: '/api/webhooks/stripe' },
      exception: { values: [{ type: 'Error', value: `Bad key ${BEARER} for ${EMAIL}`, stacktrace: { frames: [{ filename: 'a.ts', vars: { secret: 'x' } }] } }] }
    }
    const out = scrubEvent(structuredClone(event))!
    expectClean(out)
    expect(out.request).toEqual({
      method: 'POST',
      url: 'https://markoto.app/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'user-agent': 'Stripe/1.0' }
    })
    expect(out.user).toEqual({ id: 42 })
    expect(out.extra.ok).toBe(7)
    expect(out.extra.apiKey).toBe('[redacted]')
    expect(out.tags).toEqual({ password: '[redacted]', route: '/api/webhooks/stripe' })
    expect(out.message).toBe('Webhook failed for j***@example.org')
    expect(json(out.exception)).not.toContain('"vars"')
  })

  it('scrubs a sampled transaction: span descriptions and URL attributes', () => {
    const transaction = {
      type: 'transaction',
      transaction: 'GET /api/files/doc1/img?sig=abc',
      request: { url: RENDER_URL, headers: { cookie: 'session=abc' } },
      contexts: { trace: { data: { 'http.url': RENDER_URL, 'url.full': PRESIGNED } } },
      spans: [
        { description: `GET ${PRESIGNED}`, data: { 'http.url': PRESIGNED, 'url.query': 'X-Amz-Signature=deadbeef', 'http.fragment': '#x', 'server.address': 's3.gra.io.cloud.ovh.net' } },
        { description: `POST ${RENDER_URL}`, data: { 'http.request.header.authorization': `Bearer ${BEARER}` } }
      ]
    }
    const out = scrubEvent(structuredClone(transaction))!
    expectClean(out)
    expect(out.transaction).toBe('GET /api/files/doc1/img')
    expect(out.spans[0]!.description).toBe('GET https://s3.gra.io.cloud.ovh.net/markoto/docs/abc/file.png?[query]')
    expect(out.spans[0]!.data).toEqual({ 'http.url': 'https://s3.gra.io.cloud.ovh.net/markoto/docs/abc/file.png', 'server.address': 's3.gra.io.cloud.ovh.net' })
  })

  it('scrubs fetch / http / console breadcrumbs', () => {
    const fetchCrumb = scrubBreadcrumb({ category: 'fetch', data: { method: 'GET', url: PRESIGNED, status_code: 200 } })
    expect(fetchCrumb.data).toEqual({ method: 'GET', url: 'https://s3.gra.io.cloud.ovh.net/markoto/docs/abc/file.png', status_code: 200 })
    const httpCrumb = scrubBreadcrumb({ category: 'http', data: { 'url': RENDER_URL, 'http.query': '?t=eyJ' } })
    expectClean(httpCrumb)
    const consoleCrumb = scrubBreadcrumb({ category: 'console', message: `login for ${EMAIL} with Authorization: Bearer ${BEARER}` })
    expectClean(consoleCrumb)
    const nav = scrubBreadcrumb({ category: 'navigation', data: { from: '/invites/accept?token=abc', to: '/w/1#x' } })
    expect(nav.data).toEqual({ from: '/invites/accept', to: '/w/1' })
  })

  it('redacts an error message that embeds an email and a bearer token, and caps its length', () => {
    const out = scrubEvent({ exception: { values: [{ value: `upstream 401 for ${EMAIL}: Authorization: Bearer ${BEARER} ${'x'.repeat(20_000)}` }] } })!
    expectClean(out)
    expect(out.exception.values[0]!.value.length).toBeLessThan(8_100)
  })

  it('drops the event rather than sending it unscrubbed when scrubbing throws', () => {
    const hostile = {
      get message(): string {
        throw new Error('boom')
      }
    }
    expect(scrubEvent(hostile)).toBeNull()
  })

  it('never sends default PII', () => {
    expect(sentryScrubOptions.sendDefaultPii).toBe(false)
  })

  it('the renderer carries a byte-identical copy', () => {
    const root = resolve(import.meta.dirname, '../../..')
    expect(readFileSync(resolve(root, 'renderer/src/shared/utils/security/sentryScrub.ts'), 'utf8'))
      .toBe(readFileSync(resolve(root, 'shared/utils/security/sentryScrub.ts'), 'utf8'))
  })
})
