import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser } from '../integration/setup/fixtures'
import {
  confirmWaitlistSignup,
  deleteWaitlistSignupByUnsubscribeToken,
  listWaitlistSignupsForUser,
  upsertWaitlistSignup,
  type WaitlistSignupInput
} from '../../server/repos/waitlist'
import { runWaitlistSweep } from '../../server/utils/privacy/waitlistSweep'
import { first } from '../helpers/assert'
import { asUser } from '../helpers/access'

// Paid-plans waitlist repository (double opt-in lifecycle) + sweeper.

const DAY = 24 * 60 * 60 * 1000

function input(over: Partial<WaitlistSignupInput> = {}): WaitlistSignupInput {
  return {
    email: 'maya@example.com',
    locale: 'en',
    consentVersion: 1,
    consentTextId: 'waitlist.consentLabel',
    userId: null,
    confirmTokenHash: 'confirm-hash-1',
    confirmTokenExpiresAt: new Date(Date.now() + 7 * DAY),
    unsubscribeTokenHash: 'unsub-hash-1',
    ...over
  }
}

async function rows() {
  const r = await testDb().query<{
    email: string
    locale: string
    user_id: number | null
    confirm_token_hash: string | null
    unsubscribe_token_hash: string
    confirmed_at: Date | null
  }>('SELECT email, locale, user_id, confirm_token_hash, unsubscribe_token_hash, confirmed_at FROM waitlist_signups ORDER BY id')
  return r.rows
}

describe('waitlist repo', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('first sign-up creates an UNCONFIRMED row', async () => {
    expect(await upsertWaitlistSignup(input())).toBe('created')
    const row = first(await rows())
    expect(row.email).toBe('maya@example.com')
    expect(row.confirmed_at).toBeNull()
    expect(row.confirm_token_hash).toBe('confirm-hash-1')
  })

  it('re-signup while unconfirmed rotates both tokens and refreshes consent metadata', async () => {
    await upsertWaitlistSignup(input())
    const outcome = await upsertWaitlistSignup(input({
      locale: 'de',
      confirmTokenHash: 'confirm-hash-2',
      unsubscribeTokenHash: 'unsub-hash-2'
    }))
    expect(outcome).toBe('refreshed')
    const all = await rows()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ locale: 'de', confirm_token_hash: 'confirm-hash-2', unsubscribe_token_hash: 'unsub-hash-2' })
    // The old confirm link is dead.
    expect(await confirmWaitlistSignup('confirm-hash-1')).toBe(false)
  })

  it('re-signup of a confirmed address is a no-op (no email, nothing changes)', async () => {
    await upsertWaitlistSignup(input())
    expect(await confirmWaitlistSignup('confirm-hash-1')).toBe(true)
    const outcome = await upsertWaitlistSignup(input({ confirmTokenHash: 'confirm-hash-x', unsubscribeTokenHash: 'unsub-hash-x' }))
    expect(outcome).toBe('unchanged')
    const row = first(await rows())
    expect(row.unsubscribe_token_hash).toBe('unsub-hash-1')
    expect(row.confirmed_at).not.toBeNull()
  })

  it('links the account when known, and keeps an existing link on re-signup', async () => {
    const alice = await createUser()
    const bob = await createUser()
    await upsertWaitlistSignup(input({ userId: alice.id }))
    await upsertWaitlistSignup(input({ userId: bob.id, confirmTokenHash: 'c2', unsubscribeTokenHash: 'u2' }))
    const row = first(await rows())
    expect(row.user_id).toBe(alice.id)
  })

  it('confirm is single-use and refuses expired tokens', async () => {
    await upsertWaitlistSignup(input())
    expect(await confirmWaitlistSignup('confirm-hash-1')).toBe(true)
    expect(await confirmWaitlistSignup('confirm-hash-1')).toBe(false)

    await upsertWaitlistSignup(input({
      email: 'late@example.com',
      confirmTokenHash: 'confirm-late',
      confirmTokenExpiresAt: new Date(Date.now() - 1000),
      unsubscribeTokenHash: 'unsub-late'
    }))
    expect(await confirmWaitlistSignup('confirm-late')).toBe(false)
  })

  it('unsubscribe deletes the row (confirmed or not) and is idempotent', async () => {
    await upsertWaitlistSignup(input())
    await confirmWaitlistSignup('confirm-hash-1')
    expect(await deleteWaitlistSignupByUnsubscribeToken('unsub-hash-1')).toBe(true)
    expect(await rows()).toHaveLength(0)
    expect(await deleteWaitlistSignupByUnsubscribeToken('unsub-hash-1')).toBe(false)
  })

  it('export projection lists only the user\'s rows and never token hashes', async () => {
    const alice = await createUser()
    await upsertWaitlistSignup(input({ userId: alice.id }))
    await upsertWaitlistSignup(input({ email: 'other@example.com', confirmTokenHash: 'c-o', unsubscribeTokenHash: 'u-o' }))
    const exported = await listWaitlistSignupsForUser(asUser(alice.id))
    expect(exported).toHaveLength(1)
    expect(first(exported).email).toBe('maya@example.com')
    expect(JSON.stringify(exported)).not.toContain('hash')
  })

  it('account deletion cascades to the linked row (FK ON DELETE CASCADE)', async () => {
    const alice = await createUser()
    await upsertWaitlistSignup(input({ userId: alice.id }))
    await testDb().query('DELETE FROM users WHERE id = $1', [alice.id])
    expect(await rows()).toHaveLength(0)
  })
})

describe('waitlist sweep', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('deletes unconfirmed rows past the confirm window; keeps pending and confirmed ones', async () => {
    const now = new Date()
    await upsertWaitlistSignup(input({
      email: 'expired@example.com',
      confirmTokenHash: 'c-exp',
      unsubscribeTokenHash: 'u-exp',
      confirmTokenExpiresAt: new Date(now.getTime() - DAY)
    }))
    await upsertWaitlistSignup(input({ email: 'pending@example.com', confirmTokenHash: 'c-pen', unsubscribeTokenHash: 'u-pen' }))
    await upsertWaitlistSignup(input({ email: 'confirmed@example.com', confirmTokenHash: 'c-con', unsubscribeTokenHash: 'u-con' }))
    await confirmWaitlistSignup('c-con')

    const result = await runWaitlistSweep(now)
    expect(result.deletedUnconfirmed).toBe(1)
    expect((await rows()).map(r => r.email).sort()).toEqual(['confirmed@example.com', 'pending@example.com'])
  })
})
