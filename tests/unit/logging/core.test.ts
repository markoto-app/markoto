import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scrubText as scrubSentryText, scrubValue } from '../../../shared/utils/security/sentryScrub'
import { asLogLevel, createLogging, formatFor, maskEmail, sanitiseFields, scrubText, setLogSink, type LogLevel, type LogRecord } from '../../../shared/logging/core'

function logger(level: LogLevel = 'info', context?: () => Record<string, unknown> | undefined) {
  const records: LogRecord[] = []
  setLogSink(r => records.push(r))
  return { log: createLogging({ level: () => level, format: () => 'json', context })('unit'), records }
}

describe('logger core', () => {
  it('writes component, level and msg with the structured fields', () => {
    const { log, records } = logger()
    log.info('subscription updated', { subscriptionId: 'sub_1', plan: 'pro' })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ level: 'info', component: 'unit', msg: 'subscription updated', subscriptionId: 'sub_1', plan: 'pro' })
    expect(new Date(records[0]!.time).getTime()).not.toBeNaN()
    setLogSink(null)
  })

  it('drops records below the minimum level', () => {
    const { log, records } = logger('warn')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(records.map(r => r.msg)).toEqual(['w', 'e'])
    setLogSink(null)
  })

  it('with() binds fields; per-call fields and the context are merged in', () => {
    const { log, records } = logger('info', () => ({ requestId: 'req-12345678' }))
    log.with({ docId: 'd1' }).with({ sessionId: 's1' }).info('x', { extra: 1 })
    expect(records[0]).toMatchObject({ requestId: 'req-12345678', docId: 'd1', sessionId: 's1', extra: 1 })
    setLogSink(null)
  })

  it('serialises an Error to name, message and stack, with the cause', () => {
    const { log, records } = logger()
    log.error('failed', { err: new Error('outer', { cause: Object.assign(new Error('inner'), { code: 'ECONNRESET' }) }) })
    const err = records[0]!.err as Record<string, unknown>
    expect(err).toMatchObject({ name: 'Error', message: 'outer' })
    expect(String(err.stack)).toContain('outer')
    expect(err.cause).toMatchObject({ message: 'inner', code: 'ECONNRESET' })
    setLogSink(null)
  })

  it('never throws, whatever it is handed', () => {
    const { log } = logger()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const hostile = {
      get boom(): never {
        throw new Error('getter')
      }
    }
    expect(() => log.info('x', { circular, hostile, big: 10n, fn: () => 1, sym: Symbol('s') })).not.toThrow()
    const broken = createLogging({
      level: () => {
        throw new Error('runtime')
      },
      format: () => 'json'
    })
    expect(() => broken('c').info('x')).not.toThrow()
    setLogSink(null)
  })

  it('keeps field names that would collide with the record header', () => {
    const { log, records } = logger()
    log.info('real', { msg: 'spoof', level: 'debug', time: 'x' })
    expect(records[0]).toMatchObject({ msg: 'real', level: 'info', field_msg: 'spoof', field_level: 'debug', field_time: 'x' })
    setLogSink(null)
  })
})

describe('redaction', () => {
  it('masks fields named like secrets and leaves counters alone', () => {
    const out = sanitiseFields({
      token: 'abc', accessToken: 'abc', confirmToken: 'abc', password: 'p', apiKey: 'k', api_key: 'k', X_API_KEY: 'k',
      authorization: 'Bearer abc', cookie: 'a=b', clientSecret: 's', privateKey: 'pk',
      totalTokens: 12, promptTokens: 3, s3Key: 'docs/d/f.png', keyId: 'k1', tokenHash: 'h', sessionId: 's1'
    })
    for (const k of ['token', 'accessToken', 'confirmToken', 'password', 'apiKey', 'api_key', 'X_API_KEY', 'authorization', 'cookie', 'clientSecret', 'privateKey']) {
      expect(out[k], k).toBe('[redacted]')
    }
    expect(out).toMatchObject({ totalTokens: 12, promptTokens: 3, s3Key: 'docs/d/f.png', keyId: 'k1', tokenHash: 'h', sessionId: 's1' })
  })

  it('masks email fields and email addresses inside text', () => {
    expect(maskEmail('jane.doe@example.org')).toBe('j***@example.org')
    const out = sanitiseFields({ email: 'jane.doe@example.org', recipientEmail: 'bob@x.io', note: 'sent to carol@example.com today' })
    expect(out).toEqual({ email: 'j***@example.org', recipientEmail: 'b***@x.io', note: 'sent to c***@example.com today' })
  })

  it('never writes request bodies or headers', () => {
    expect(sanitiseFields({ body: { text: 'secret doc' }, headers: { cookie: 'a' }, payload: 'x' })).toEqual({ body: '[omitted]', headers: '[omitted]', payload: '[omitted]' })
  })

  it('cuts URL query strings and credentials (render tokens, presigned URLs)', () => {
    expect(scrubText('GET https://app.example.org/_internal/render/d1?t=eyJhbGciOiJIUzI1NiJ9.abcdefghij.klmnopqrst failed'))
      .toBe('GET https://app.example.org/_internal/render/d1?[query] failed')
    expect(scrubText('https://bucket.s3.example.org/docs/d/f.png?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA')).toBe('https://bucket.s3.example.org/docs/d/f.png?[query]')
    expect(scrubText('connect postgres://admin:hunter2@db.internal:5432/app refused')).toBe('connect postgres://[redacted]@db.internal:5432/app refused')
  })

  it('masks bearer tokens, JWTs and provider keys inside text', () => {
    expect(scrubText('Authorization: Bearer abcdefghijklmnop')).toContain('Bearer [redacted]')
    expect(scrubText('bad jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk')).toBe('bad jwt [redacted]')
    expect(scrubText('Incorrect API key provided: sk-abcdefghijklmnopqrstuvwx.')).toBe('Incorrect API key provided: [redacted].')
  })

  it('truncates long strings, long arrays and deep objects', () => {
    const out = sanitiseFields({ text: 'x'.repeat(5000), list: Array.from({ length: 50 }, (_, i) => i), deep: { a: { b: { c: { d: { e: 1 } } } } } })
    expect(String(out.text).length).toBeLessThan(600)
    expect((out.list as unknown[]).length).toBe(21)
    expect(JSON.stringify(out.deep)).toContain('[nested]')
  })

  it('redacts inside Error messages too', () => {
    const { log, records } = logger()
    log.error('upstream failed', { err: new Error('401 for https://api.example.com/v1?key=sk-abcdefghijklmnopqrstuvwx and a@b.co') })
    expect(JSON.stringify(records[0])).not.toMatch(/key=sk-|a@b\.co/)
    setLogSink(null)
  })
})

describe('one redaction core for logs and Sentry', () => {
  // shared/logging/redaction.ts: the token shapes are the same for both, only
  // the key policy and the limits differ.
  it('masks the same secret shapes in free text on both paths', () => {
    const text = 'retry https://s3.example.org/f.png?X-Amz-Signature=deadbeef with token=abcdef123 for a@b.co'
    for (const out of [scrubText(text), scrubSentryText(text)]) {
      expect(out).not.toMatch(/deadbeef|abcdef123|a@b\.co/)
      expect(out).toContain('https://s3.example.org/f.png?[query]')
    }
    expect(scrubText('connect token=abcdef123')).toBe('connect token=[redacted]')
  })

  it('keeps ids readable in logs but masks them for Sentry', () => {
    expect(sanitiseFields({ sessionId: 's1', s3Key: 'docs/d/f.png' })).toEqual({ sessionId: 's1', s3Key: 'docs/d/f.png' })
    expect(scrubValue({ sessionId: 's1', s3Key: 'docs/d/f.png' })).toEqual({ sessionId: '[redacted]', s3Key: '[redacted]' })
  })

  it('serialises an Error the same way on both paths', () => {
    const err = new Error('failed for jane@example.org')
    expect(sanitiseFields({ err }).err).toMatchObject({ name: 'Error', message: 'failed for j***@example.org' })
    expect(scrubValue({ err })).toMatchObject({ err: { name: 'Error', message: 'failed for j***@example.org' } })
  })
})

describe('format and level helpers', () => {
  it('chooses JSON in production, silence under Vitest and pretty otherwise', () => {
    expect(formatFor('production')).toBe('json')
    expect(formatFor('test')).toBe('silent')
    expect(formatFor('development')).toBe('pretty')
    expect(formatFor(undefined)).toBe('pretty')
  })

  it('asLogLevel falls back to info', () => {
    expect(asLogLevel('debug')).toBe('debug')
    expect(asLogLevel('verbose')).toBe('info')
    expect(asLogLevel(undefined)).toBe('info')
  })
})

describe('the renderer copy', () => {
  it.each(['core.ts', 'redaction.ts'])('mirrors shared/logging/%s byte for byte (the renderer image cannot import shared/)', (file) => {
    const root = resolve(__dirname, '../../..')
    expect(readFileSync(resolve(root, 'renderer/src/shared/logging', file), 'utf8'))
      .toBe(readFileSync(resolve(root, 'shared/logging', file), 'utf8'))
  })
})
