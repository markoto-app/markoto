import { beforeEach, describe, expect, it } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'
import { TEST_BILLING_OFF_BASE_URL } from '../setup/env'

// Google Ads click-id conversions over real HTTP (docs/SELF-HOSTING.md#analytics-optional).
// The billing-off twin runs the hosted shape with
// NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS=true; the primary has it off.

const OFF = TEST_BILLING_OFF_BASE_URL
const CLICK = { type: 'gclid', value: 'Cj0KCQiA-integration-1' }

async function rows() {
  const r = await testDb().query<{ click_id: string, conversion: string, user_id: number | null, waitlist_signup_id: number | null }>(
    'SELECT click_id, conversion, user_id, waitlist_signup_id FROM ad_click_conversions ORDER BY id')
  return r.rows
}

describe('ad click conversions', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('a waitlist sign-up with a click id records a waitlist_signup tied to the entry', async () => {
    const res = await anonClient(OFF).post('/api/waitlist', { email: 'ad@example.com', consent: true, attribution: CLICK })
    expect(res.status).toBe(202)
    const r = await rows()
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ click_id: CLICK.value, conversion: 'waitlist_signup', user_id: null })
    expect(r[0]!.waitlist_signup_id).not.toBeNull()
  })

  it('Global Privacy Control or Do Not Track: nothing is recorded, the request still succeeds', async () => {
    for (const headers of [{ 'sec-gpc': '1' }, { dnt: '1' }] as Array<Record<string, string>>) {
      const res = await anonClient(OFF).post('/api/waitlist', { email: `gpc-${Object.keys(headers)[0]}@example.com`, consent: true, attribution: CLICK }, { headers })
      expect(res.status).toBe(202)
    }
    expect(await rows()).toEqual([])
  })

  it('a malformed click id is ignored, never an error', async () => {
    const res = await anonClient(OFF).post('/api/waitlist', { email: 'x@example.com', consent: true, attribution: { type: 'gclid', value: '<script>' } })
    expect(res.status).toBe(202)
    expect(await rows()).toEqual([])
  })

  it('a signed-in first document with a click id counts once per click', async () => {
    const u = await createUser()
    const c = await loggedInClient(u.id, u.name, OFF)
    expect((await c.post('/api/docs', { title: 'One', attribution: CLICK })).status).toBe(200)
    expect((await c.post('/api/docs', { title: 'Two', attribution: CLICK })).status).toBe(200)
    expect(await rows()).toEqual([{ click_id: CLICK.value, conversion: 'first_document', user_id: u.id, waitlist_signup_id: null }])
  })

  it('the primary server (conversions off) records nothing', async () => {
    const u = await createUser()
    const c = await loggedInClient(u.id, u.name)
    expect((await c.post('/api/docs', { title: 'One', attribution: CLICK })).status).toBe(200)
    expect(await rows()).toEqual([])
  })
})
