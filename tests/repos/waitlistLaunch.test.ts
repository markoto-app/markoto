import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { upsertWaitlistSignup, confirmWaitlistSignup } from '../../server/repos/waitlist'
import { runWaitlistLaunch, type WaitlistLaunchOptions } from '../../server/utils/privacy/waitlistLaunch'
import type { SendEmailArgs } from '../../server/utils/email/sendEmail'
import { stubEnv } from '../helpers/env'

// The paid-plans launch email (one-shot operator CLI): every confirmed
// sign-up is mailed once and deleted right after its send; unconfirmed
// sign-ups are deleted unmailed; a failed send keeps its row for a rerun.

const DAY = 24 * 60 * 60 * 1000

async function signUp(email: string, locale: string, confirmed: boolean): Promise<void> {
  const hash = `confirm-${email}`
  await upsertWaitlistSignup({
    email,
    locale,
    consentVersion: 1,
    consentTextId: 'waitlist.consentLabel',
    userId: null,
    confirmTokenHash: hash,
    confirmTokenExpiresAt: new Date(Date.now() + 7 * DAY),
    unsubscribeTokenHash: `unsub-${email}`
  })
  if (confirmed) expect(await confirmWaitlistSignup(hash)).toBe(true)
}

async function remaining(): Promise<string[]> {
  const r = await testDb().query<{ email: string }>('SELECT email FROM waitlist_signups ORDER BY email')
  return r.rows.map(row => row.email)
}

function recorder(failFor: string[] = []) {
  const sent: SendEmailArgs[] = []
  const send = vi.fn(async (args: SendEmailArgs) => {
    if (args.to && failFor.includes(args.to)) throw new Error('resend send failed: rate_limit_exceeded')
    sent.push(args)
    return { delivered: true }
  })
  return { sent, send }
}

function options(over: Partial<WaitlistLaunchOptions> = {}): WaitlistLaunchOptions {
  return {
    code: 'LAUNCH40',
    expiresOn: '2099-12-10',
    dryRun: false,
    intervalMs: 0,
    sleep: async () => {},
    deliveryConfigured: () => true,
    ...over
  }
}

describe('waitlist launch email', () => {
  beforeEach(async () => {
    await resetDb()
    stubEnv({ NUXT_BILLING_ENABLED: 'true', NUXT_SITE_URL: 'https://markoto.test' })
    await signUp('ana@example.com', 'es', true)
    await signUp('ben@example.com', 'de', true)
    await signUp('chen@example.com', 'zh', true)
    await signUp('dora@example.com', 'en', false)
  })

  it('mails every confirmed sign-up in its language, then deletes it; unconfirmed ones are deleted unmailed', async () => {
    const { sent, send } = recorder()
    const summary = await runWaitlistLaunch(options({ send }))

    expect(summary).toEqual({ confirmed: 3, unconfirmed: 1, sent: 3, failed: 0, deletedUnconfirmed: 1, stopped: false })
    expect(sent.map(m => m.to).sort()).toEqual(['ana@example.com', 'ben@example.com', 'chen@example.com'])
    const ben = sent.find(m => m.to === 'ben@example.com')
    expect(ben).toMatchObject({ kind: 'waitlist.launch', locale: 'de' })
    expect(ben?.body).toContain('https://markoto.test/pricing')
    expect(ben?.body).toContain('LAUNCH40')
    expect(sent.find(m => m.to === 'ana@example.com')?.locale).toBe('es')
    expect(await remaining()).toEqual([])
  })

  it('a failed send keeps its row; a rerun mails only that one', async () => {
    const first = recorder(['ben@example.com'])
    const summary = await runWaitlistLaunch(options({ send: first.send }))
    expect(summary).toMatchObject({ sent: 2, failed: 1 })
    // Tried twice (one retry), then left for the next run.
    expect(first.send.mock.calls.filter(([a]) => a.to === 'ben@example.com')).toHaveLength(2)
    expect(await remaining()).toEqual(['ben@example.com'])

    const second = recorder()
    expect(await runWaitlistLaunch(options({ send: second.send }))).toMatchObject({ confirmed: 1, unconfirmed: 0, sent: 1, failed: 0 })
    expect(second.sent.map(m => m.to)).toEqual(['ben@example.com'])
    expect(await remaining()).toEqual([])
  })

  it('dry run counts only: nothing sent, nothing deleted', async () => {
    const { send } = recorder()
    const lines: string[] = []
    const summary = await runWaitlistLaunch(options({ send, dryRun: true, log: line => lines.push(line) }))
    expect(summary).toMatchObject({ confirmed: 3, unconfirmed: 1, sent: 0, deletedUnconfirmed: 0 })
    expect(send).not.toHaveBeenCalled()
    expect(await remaining()).toHaveLength(4)
    expect(lines.join('\n')).not.toContain('@')
  })

  it('refuses while billing is off, and without real email delivery', async () => {
    const { send } = recorder()
    stubEnv({ NUXT_BILLING_ENABLED: 'false' })
    await expect(runWaitlistLaunch(options({ send }))).rejects.toThrow(/billing is off/)
    stubEnv({ NUXT_BILLING_ENABLED: 'true' })
    await expect(runWaitlistLaunch(options({ send, deliveryConfigured: () => false }))).rejects.toThrow(/email delivery is not configured/)
    expect(send).not.toHaveBeenCalled()
    expect(await remaining()).toHaveLength(4)
  })

  it('stops after repeated failures in a row, keeping every unsent row', async () => {
    const send = vi.fn(async () => {
      throw new Error('resend send failed: validation_error')
    })
    for (const name of ['eva', 'finn', 'gus']) await signUp(`${name}@example.com`, 'en', true)
    const summary = await runWaitlistLaunch(options({ send }))
    expect(summary).toMatchObject({ sent: 0, failed: 5, stopped: true })
    expect(await remaining()).toHaveLength(6)
  })
})
