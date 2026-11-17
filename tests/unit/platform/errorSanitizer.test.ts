import { describe, it, expect } from 'vitest'
import { buildSanitizedErrorPayload } from '../../../server/error'

// Pin the sanitization policy. The actual handler that calls this
// also writes the response via h3 helpers, we test the policy in
// isolation here so a refactor that changes the I/O can't quietly
// drift the policy.

describe('buildSanitizedErrorPayload: 4xx pass-through', () => {
  it('keeps the author-controlled message + data on a 400', () => {
    const out = buildSanitizedErrorPayload({
      statusCode: 400,
      statusMessage: 'Bad Request',
      message: 'Description too long (max 1024)',
      data: { code: 'validation/desc-too-long' }
    }, '/api/workspaces')

    expect(out).toEqual({
      statusCode: 400,
      statusMessage: 'Bad Request',
      message: 'Description too long (max 1024)',
      url: '/api/workspaces',
      data: { code: 'validation/desc-too-long' }
    })
  })

  it('keeps message + data on a 409 (conflict / domain error)', () => {
    const out = buildSanitizedErrorPayload({
      statusCode: 409,
      message: 'an export is already in progress',
      data: { code: 'export/conflict' }
    }, '/api/user/export')
    expect(out.message).toBe('an export is already in progress')
    expect(out.data).toEqual({ code: 'export/conflict' })
  })

  it('keeps message on a 401/403 even without data', () => {
    const out = buildSanitizedErrorPayload({
      statusCode: 403,
      message: 'Admin access required'
    })
    expect(out.message).toBe('Admin access required')
    expect(out.statusCode).toBe(403)
  })

  it('does not include `data` when the error did not provide it', () => {
    const out = buildSanitizedErrorPayload({
      statusCode: 400,
      message: 'Invalid version'
    })
    expect(out).not.toHaveProperty('data')
  })
})

describe('buildSanitizedErrorPayload: 5xx strip', () => {
  it('strips the original message on a 500', () => {
    const out = buildSanitizedErrorPayload({
      statusCode: 500,
      message: 'Failed query: insert into "abuse_reports" (...) values ($1, $2)\nparams: rep-Abc, joel@example.com'
    }, '/api/abuse-reports')

    expect(out.message).not.toContain('Failed query')
    expect(out.message).not.toContain('params')
    expect(out.message).not.toContain('joel@example.com')
    expect(out.message).toBe('Something went wrong on our side. Please try again. We\'ve been notified.')
    expect(out.data).toEqual({ code: 'internal' })
  })

  it('replaces user-attached data with the internal-code shape', () => {
    const out = buildSanitizedErrorPayload({
      statusCode: 500,
      message: 'whatever',
      data: { sql: 'SELECT * FROM users', sensitive: 'secret' }
    })
    expect(out.data).toEqual({ code: 'internal' })
    expect(JSON.stringify(out)).not.toContain('SELECT')
    expect(JSON.stringify(out)).not.toContain('secret')
  })

  it('treats a thrown raw Error (no statusCode) as 500', () => {
    const out = buildSanitizedErrorPayload({
      message: 'connection refused'
    })
    expect(out.statusCode).toBe(500)
    expect(out.message).not.toContain('connection refused')
    expect(out.data).toEqual({ code: 'internal' })
  })

  it('keeps a registered 5xx code without params (and nothing else)', () => {
    const out = buildSanitizedErrorPayload({
      statusCode: 502,
      message: 'The image provider is not available right now. Try again later.',
      data: { code: 'ai/image-provider-unavailable', upstream: 'Client error 429 SECRETS_HERE' }
    }, '/api/docs/abc/images/generate')
    expect(out.data).toEqual({ code: 'ai/image-provider-unavailable' })
    expect(out.message).toBe('Something went wrong on our side. Please try again. We\'ve been notified.')
    expect(JSON.stringify(out)).not.toContain('SECRETS')
  })

  it('drops a registered code that carries params, an unregistered code and a 4xx code on a 5xx', () => {
    for (const code of ['admin/spend-unavailable', 'made-up/code', 'ai/budget-exhausted']) {
      const out = buildSanitizedErrorPayload({ statusCode: 502, data: { code, upstreamStatus: 503 } })
      expect(out.data, code).toEqual({ code: 'internal' })
    }
  })

  it('treats statusCode=502/503 as server-error too', () => {
    for (const code of [502, 503, 504]) {
      const out = buildSanitizedErrorPayload({
        statusCode: code,
        message: 'upstream down: SECRETS_HERE'
      })
      expect(out.message).not.toContain('SECRETS')
      expect(out.data).toEqual({ code: 'internal' })
    }
  })
})

describe('buildSanitizedErrorPayload: stack never leaks', () => {
  it('does not include `stack` even when present on the input', () => {
    const errorWithStack = {
      statusCode: 500,
      message: 'boom',
      stack: 'Error: boom\n    at /path/to/secret.ts:42:7'
    }
    const out = buildSanitizedErrorPayload(errorWithStack)
    expect(JSON.stringify(out)).not.toContain('stack')
    expect(JSON.stringify(out)).not.toContain('/path/to/secret.ts')
    expect(out).not.toHaveProperty('stack')
  })

  it('does not include stack on 4xx either', () => {
    const errorWithStack = {
      statusCode: 400,
      message: 'bad',
      stack: 'Error: bad\n    at /secret.ts:1:1'
    }
    const out = buildSanitizedErrorPayload(errorWithStack)
    expect(out).not.toHaveProperty('stack')
  })
})

describe('buildSanitizedErrorPayload: statusMessage defaults', () => {
  it('falls back to "Server Error" for 5xx without statusMessage', () => {
    const out = buildSanitizedErrorPayload({ statusCode: 500 })
    expect(out.statusMessage).toBe('Server Error')
  })

  it.each([
    [400, 'Bad Request'],
    [401, 'Unauthorized'],
    [402, 'Payment Required'],
    [403, 'Forbidden'],
    [404, 'Not Found'],
    [409, 'Conflict'],
    [410, 'Gone'],
    [429, 'Too Many Requests']
  ])('a %i without statusMessage says "%s", never the phrase of another status', (statusCode, phrase) => {
    expect(buildSanitizedErrorPayload({ statusCode }).statusMessage).toBe(phrase)
  })

  it('a 4xx we have no phrase for is not called "Bad Request"', () => {
    expect(buildSanitizedErrorPayload({ statusCode: 418 }).statusMessage).toBe('Client Error')
  })

  it('keeps explicit statusMessage when provided', () => {
    const out = buildSanitizedErrorPayload({ statusCode: 404, statusMessage: 'Not Found' })
    expect(out.statusMessage).toBe('Not Found')
  })
})
