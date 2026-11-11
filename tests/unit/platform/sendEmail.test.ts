import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  safeSendTransactionalEmail,
  sendTransactionalEmail
} from '../../../server/utils/email/sendEmail'

// Email helper unit tests. Today the helper is a stub (no provider
// dispatch); these tests pin its observable contract so when we plug
// in a real provider the call shape doesn't drift.

const ORIGINAL_PROVIDER = process.env.NUXT_EMAIL_PROVIDER
const ORIGINAL_RESEND_KEY = process.env.RESEND_API_KEY

function restoreEnv(): void {
  if (ORIGINAL_PROVIDER === undefined) delete process.env.NUXT_EMAIL_PROVIDER
  else process.env.NUXT_EMAIL_PROVIDER = ORIGINAL_PROVIDER
  if (ORIGINAL_RESEND_KEY === undefined) delete process.env.RESEND_API_KEY
  else process.env.RESEND_API_KEY = ORIGINAL_RESEND_KEY
}

describe('sendTransactionalEmail (stub mode)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    delete process.env.NUXT_EMAIL_PROVIDER
    delete process.env.RESEND_API_KEY
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    restoreEnv()
    logSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('returns delivered=true and logs in stub mode', async () => {
    const result = await sendTransactionalEmail({
      kind: 'account.delete_requested',
      to: 'alice@example.com',
      locale: 'en',
      subject: 'Hello',
      body: 'Body text'
    })
    expect(result.delivered).toBe(true)
    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = String(logSpy.mock.calls[0]![0])
    expect(logged).toContain('email-stub')
    expect(logged).toContain('account-delete-requested')
  })

  it('redacts the email address in logs', async () => {
    await sendTransactionalEmail({
      kind: 'account.delete_requested',
      to: 'alicelongname@example.com',
      locale: null,
      subject: 'x', body: 'y'
    })
    const logged = String(logSpy.mock.calls[0]![0])
    expect(logged).not.toContain('alicelongname@example.com')
    expect(logged).toContain('a***@example.com')
  })

  it('truncates long bodies in the log line', async () => {
    const longBody = 'x'.repeat(500)
    await sendTransactionalEmail({
      kind: 'data_export.ready',
      to: 'alice@example.com',
      locale: 'en',
      subject: 's',
      body: longBody
    })
    const logged = String(logSpy.mock.calls[0]![0])
    // 280-char preview + ellipsis
    expect(logged).toContain('xxxxxxxxxx…')
    expect(logged.length).toBeLessThan(longBody.length + 200)
  })

  it('no-ops when recipient is null (no email on file)', async () => {
    const result = await sendTransactionalEmail({
      kind: 'breach.notification',
      to: null,
      locale: null,
      subject: 's', body: 'b'
    })
    expect(result.delivered).toBe(false)
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(String(logSpy.mock.calls[0]![0])).toContain('no-recipient skip')
  })

  it('warns + falls back to stub when provider is set to an unknown name', async () => {
    // Both an API key AND an explicit-but-unknown provider — the
    // dispatch path with the unknown provider name returns false
    // and warns. Without the key set, we'd hit the stub branch
    // first and never reach the warning.
    process.env.RESEND_API_KEY = 're_unused'
    process.env.NUXT_EMAIL_PROVIDER = 'mailgun'
    const result = await sendTransactionalEmail({
      kind: 'account.delete_executed',
      to: 'alice@example.com',
      locale: 'en',
      subject: 's', body: 'b'
    })
    expect(result.delivered).toBe(false)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]![0])).toContain('provider=mailgun')
  })

  it('treats NUXT_EMAIL_PROVIDER=stub as an explicit opt-out even when RESEND_API_KEY is set', async () => {
    process.env.RESEND_API_KEY = 're_unused'
    process.env.NUXT_EMAIL_PROVIDER = 'stub'
    const result = await sendTransactionalEmail({
      kind: 'account.delete_requested',
      to: 'alice@example.com',
      locale: 'en',
      subject: 'Hello', body: 'Body'
    })
    expect(result.delivered).toBe(true)
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(String(logSpy.mock.calls[0]![0])).toContain('email-stub')
  })
})

describe('safeSendTransactionalEmail', () => {
  beforeEach(() => {
    delete process.env.NUXT_EMAIL_PROVIDER
    delete process.env.RESEND_API_KEY
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    restoreEnv()
    vi.restoreAllMocks()
  })

  it('returns the result on success', async () => {
    const result = await safeSendTransactionalEmail({
      kind: 'consent.version_bump',
      to: 'a@b.c',
      locale: 'en',
      subject: 's', body: 'b'
    })
    expect(result?.delivered).toBe(true)
  })

  it('returns null when the underlying sender throws (never propagates)', async () => {
    // Force the underlying call to throw by spying on console.log to throw —
    // stub mode logs before returning; throwing there mimics a provider
    // crash inside the dispatch branch.
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('boom')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await safeSendTransactionalEmail({
      kind: 'account.delete_requested',
      to: 'a@b.c',
      locale: 'en',
      subject: 's', body: 'b'
    })
    expect(result).toBeNull()
  })
})
