import { beforeEach, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { resetDb, testDb } from '../integration/setup/db'
import { TEST_DB_NAME, TEST_DB_URL } from '../integration/setup/env'
import { createUser } from '../integration/setup/fixtures'
import {
  adConversionsForExport,
  deleteAdConversionsBefore,
  pendingAdConversions,
  recordAdConversion,
  recordFirstDocumentFromSignupClick,
  recordWaitlistAdConversion
} from '../../server/repos/adConversions'
import { upsertWaitlistSignup } from '../../server/repos/waitlist'
import { runAdConversionSweep } from '../../server/utils/analytics/adConversionSweep'
import { asUser, sys } from '../helpers/access'
import { stubEnv } from '../helpers/env'

// Google Ads click-id conversions (docs/SELF-HOSTING.md#analytics-optional).

const CLICK = { type: 'gclid' as const, value: 'Cj0KCQiA-test-click-1' }
const DAY = 24 * 60 * 60 * 1000

async function kinds(): Promise<string[]> {
  const r = await testDb().query<{ conversion: string }>('SELECT conversion FROM ad_click_conversions ORDER BY id')
  return r.rows.map(x => x.conversion)
}

describe('ad click conversions', () => {
  beforeEach(async () => {
    await resetDb()
    stubEnv({ NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS: 'true' })
  })

  it('records a click once per kind', async () => {
    expect(await recordAdConversion(sys(), { clickId: CLICK, conversion: 'first_document' })).toBe(true)
    expect(await recordAdConversion(sys(), { clickId: CLICK, conversion: 'first_document' })).toBe(false)
    expect(await recordAdConversion(sys(), { clickId: CLICK, conversion: 'signup' })).toBe(true)
    expect(await kinds()).toEqual(['first_document', 'signup'])
  })

  it('the first document of an ad-acquired account reuses its sign-up click; other accounts record nothing', async () => {
    const ad = await createUser()
    const plain = await createUser()
    await recordAdConversion(sys(), { clickId: CLICK, conversion: 'signup', userId: ad.id })
    expect(await recordFirstDocumentFromSignupClick(asUser(plain.id))).toBe(false)
    expect(await recordFirstDocumentFromSignupClick(asUser(ad.id))).toBe(true)
    expect(await recordFirstDocumentFromSignupClick(asUser(ad.id))).toBe(false)
    expect(await kinds()).toEqual(['signup', 'first_document'])
    const exported = await adConversionsForExport(asUser(ad.id))
    expect(exported.map(e => e.conversion)).toEqual(['signup', 'first_document'])
    expect(exported[0]!.clickId).toBe(CLICK.value)
    expect(await adConversionsForExport(asUser(plain.id))).toEqual([])
  })

  it('account deletion removes the rows (cascade)', async () => {
    const u = await createUser()
    await recordAdConversion(sys(), { clickId: CLICK, conversion: 'signup', userId: u.id })
    await testDb().query('DELETE FROM users WHERE id = $1', [u.id])
    expect(await kinds()).toEqual([])
  })

  it('waitlist: sign-up, confirmation via the sweep, unsubscribe removes both', async () => {
    await upsertWaitlistSignup({
      email: 'ad@example.com',
      locale: 'en',
      consentVersion: 1,
      consentTextId: 'waitlist.consentLabel',
      userId: null,
      confirmTokenHash: 'c-hash',
      confirmTokenExpiresAt: new Date(Date.now() + DAY),
      unsubscribeTokenHash: 'u-hash'
    })
    expect(await recordWaitlistAdConversion(sys(), CLICK, 'nobody@example.com')).toBe(false)
    expect(await recordWaitlistAdConversion(sys(), CLICK, 'ad@example.com')).toBe(true)
    expect((await runAdConversionSweep()).confirmedAdded).toBe(0)
    await testDb().query('UPDATE waitlist_signups SET confirmed_at = now() WHERE email = $1', ['ad@example.com'])
    expect((await runAdConversionSweep()).confirmedAdded).toBe(1)
    expect((await runAdConversionSweep()).confirmedAdded).toBe(0)
    expect(await kinds()).toEqual(['waitlist_signup', 'waitlist_confirmed'])
    await testDb().query('DELETE FROM waitlist_signups WHERE email = $1', ['ad@example.com'])
    expect(await kinds()).toEqual([])
  })

  it('retention: the sweep deletes rows past NUXT_ADS_CONVERSION_RETENTION_DAYS, also with conversions off', async () => {
    await recordAdConversion(sys(), { clickId: CLICK, conversion: 'signup' })
    await recordAdConversion(sys(), { clickId: { type: 'wbraid', value: 'CjkKCQiA-recent' }, conversion: 'signup' })
    await testDb().query('UPDATE ad_click_conversions SET converted_at = now() - interval \'91 days\' WHERE click_id = $1', [CLICK.value])
    stubEnv({ NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS: 'false' })
    expect((await runAdConversionSweep()).deleted).toBe(1)
    expect(await deleteAdConversionsBefore(sys(), new Date(Date.now() - DAY))).toBe(0)
    const pending = await pendingAdConversions(sys(), 10)
    expect(pending.map(p => p.clickIdType)).toEqual(['wbraid'])
  })
})

describe('db-init: the analytics database', () => {
  // The test stack's db-init runs with UMAMI_DB=umami_test (deploy/compose/compose.test.yml).
  it('creates umami_test owned by its own role, with pgcrypto, closed to PUBLIC', async () => {
    const db = await testDb().query<{ owner: string, acl: string | null }>(
      'SELECT pg_get_userbyid(datdba) AS owner, datacl::text AS acl FROM pg_database WHERE datname = $1', ['umami_test'])
    expect(db.rows[0]?.owner).toBe('umami_test')
    // No `=c/` entry: PUBLIC lost CONNECT.
    expect(db.rows[0]?.acl ?? '').not.toMatch(/(^|[{,])=[^,}]*c/)
    const role = await testDb().query<{ rolsuper: boolean, rolcreatedb: boolean, rolcreaterole: boolean }>(
      'SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1', ['umami_test'])
    expect(role.rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false })
    const umami = new Client({ connectionString: TEST_DB_URL.replace(new RegExp(`/${TEST_DB_NAME}$`), '/umami_test') })
    await umami.connect()
    try {
      const ext = await umami.query('SELECT 1 FROM pg_extension WHERE extname = $1', ['pgcrypto'])
      expect(ext.rowCount).toBe(1)
    } finally {
      await umami.end()
    }
  })
})
