import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { TEST_DB_NAME, TEST_DB_URL } from '../integration/setup/env'
import { analyticsEnabled, runUmamiRetentionSweep } from '../../server/utils/analytics/umamiRetentionSweep'
import { closeUmamiPool } from '../../server/db/umami'
import { stubEnv } from '../helpers/env'

// Retention of Umami's visitor data (docs/operations-analytics.md), against
// the `umami_test` database the test stack's db-init creates for its own
// role. Umami itself never runs in the test stack, so the test creates the
// two tables it checks with Umami's column names.

const UMAMI_URL = TEST_DB_URL.replace(new RegExp(`/${TEST_DB_NAME}$`), '/umami_test')
  .replace(/\/\/[^@]+@/, '//umami_test:umamitestpassword@')
const DAY = 24 * 60 * 60 * 1000

async function withUmami<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: UMAMI_URL })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

describe('Umami retention sweep', () => {
  beforeEach(async () => {
    stubEnv({
      NUXT_PUBLIC_ANALYTICS_WEBSITE_ID: '0d2c6a3e-1b4f-4a8e-9c0d-123456789abc',
      NUXT_ANALYTICS_DB_USER: 'umami_test',
      NUXT_ANALYTICS_DB_PASSWORD: 'umamitestpassword',
      NUXT_ANALYTICS_DB_NAME: 'umami_test'
    })
    await closeUmamiPool()
    await withUmami(async (c) => {
      await c.query('CREATE TABLE IF NOT EXISTS website_event (event_id uuid, created_at timestamptz)')
      await c.query('CREATE TABLE IF NOT EXISTS session (session_id uuid, created_at timestamptz)')
      await c.query('TRUNCATE website_event, session')
    })
  })

  afterAll(async () => {
    await closeUmamiPool()
    await withUmami(c => c.query('DROP TABLE IF EXISTS website_event, session'))
  })

  it('runs only where analytics is configured', () => {
    expect(analyticsEnabled()).toBe(true)
    stubEnv({ NUXT_PUBLIC_ANALYTICS_WEBSITE_ID: undefined })
    expect(analyticsEnabled()).toBe(false)
  })

  it('deletes events and sessions older than 13 months, keeps newer ones, skips missing tables', async () => {
    const old = new Date(Date.now() - 400 * DAY)
    const recent = new Date(Date.now() - 10 * DAY)
    await withUmami(async (c) => {
      await c.query('INSERT INTO website_event VALUES (gen_random_uuid(), $1), (gen_random_uuid(), $2)', [old, recent])
      await c.query('INSERT INTO session VALUES (gen_random_uuid(), $1)', [old])
    })
    expect(await runUmamiRetentionSweep()).toEqual({ website_event: 1, session: 1 })
    expect(await runUmamiRetentionSweep()).toBeUndefined()
    const left = await withUmami(c => c.query<{ n: string }>('SELECT count(*)::text AS n FROM website_event'))
    expect(left.rows[0]?.n).toBe('1')
  })
})
