import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureLogs } from '../../helpers/logs'
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

const logs = captureLogs()

describe('sendTransactionalEmail (stub mode)', () => {
  beforeEach(() => {
    delete process.env.NUXT_EMAIL_PROVIDER
    delete process.env.RESEND_API_KEY
  })

  afterEach(() => {
    restoreEnv()
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
    expect(logs.all()).toHaveLength(1)
    expect(logs.find('info', 'email stubbed, not sent')).toMatchObject({ component: 'email', kind: 'account-delete-requested' })
  })

  it('redacts the email address in logs', async () => {
    await sendTransactionalEmail({
      kind: 'account.delete_requested',
      to: 'alicelongname@example.com',
      locale: null,
      subject: 'x', body: 'y'
    })
    const logged = JSON.stringify(logs.records[0])
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
    const logged = String(logs.records[0]!.bodyPreview)
    // 280-char preview + ellipsis
    expect(logged).toContain('xxxxxxxxxx…')
    expect(logged.length).toBeLessThan(longBody.length)
  })

  it('no-ops when recipient is null (no email on file)', async () => {
    const result = await sendTransactionalEmail({
      kind: 'breach.notification',
      to: null,
      locale: null,
      subject: 's', body: 'b'
    })
    expect(result.delivered).toBe(false)
    expect(logs.all()).toHaveLength(1)
    expect(logs.find('info', 'no recipient, skipped')).toBeDefined()
  })

  it('an unknown provider name is a configuration error (boot validation refuses it)', async () => {
    process.env.RESEND_API_KEY = 're_unused'
    process.env.NUXT_EMAIL_PROVIDER = 'mailgun'
    await expect(sendTransactionalEmail({
      kind: 'account.delete_executed',
      to: 'alice@example.com',
      locale: 'en',
      subject: 's', body: 'b'
    })).rejects.toThrow(/NUXT_EMAIL_PROVIDER: expected one of resend, stub/)
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
    expect(logs.find('info', 'email stubbed, not sent')).toBeDefined()
  })
})

describe('safeSendTransactionalEmail', () => {
  beforeEach(() => {
    delete process.env.NUXT_EMAIL_PROVIDER
    delete process.env.RESEND_API_KEY
  })

  afterEach(() => {
    restoreEnv()
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
    // An unknown provider name makes the underlying sender throw (boot
    // validation refuses it; a runtime read does not).
    process.env.RESEND_API_KEY = 're_unused'
    process.env.NUXT_EMAIL_PROVIDER = 'mailgun'

    const result = await safeSendTransactionalEmail({
      kind: 'account.delete_requested',
      to: 'a@b.c',
      locale: 'en',
      subject: 's', body: 'b'
    })
    expect(result).toBeNull()
  })
})
