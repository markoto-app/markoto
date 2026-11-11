import { describe, it, expect, beforeEach } from 'vitest'
import { solveChallenge } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient, type TestClient } from '../setup/client'
import { createUser } from '../setup/fixtures'
import { anonGateFields, createAnonDoc, solveAnonChallenge } from '../setup/anonGate'
import { TEST_ALTCHA_HMAC_KEY, TEST_BILLING_OFF_BASE_URL } from '../setup/env'
import { TOS_VERSION } from '../../../shared/legal/versions'
import { ANON_DOC_CREATE_LIMITS } from '../../../shared/config/anonLimits'
import {
  TEST_DIFFICULTY,
  createAnonChallenge,
  deriveAltchaSecrets
} from '../../../server/utils/anonGate/altcha'
import { encodeAltchaPayload } from '../../../app/utils/platform/altchaSolver'

// Anonymous document creation through the gate (server/utils/anonGate/):
// terms acceptance + a fresh, single-use ALTCHA solution, recorded on the
// row; signed-in users unaffected; per-client hourly limit.

async function code(res: Response): Promise<string | undefined> {
  const json = await res.json() as { data?: { code?: string } }
  return json.data?.code
}

async function docRow(docId: string) {
  const r = await testDb().query<{ owner_id: number | null, anon_terms_version: number | null, anon_terms_accepted_at: Date | null }>(
    'SELECT owner_id, anon_terms_version, anon_terms_accepted_at FROM documents WHERE doc_id = $1',
    [docId]
  )
  return r.rows[0]
}

/** A fresh client key per test: the server trusts one proxy hop. */
function randomTestIp(): string {
  const octet = () => Math.floor(Math.random() * 250) + 1
  return `198.${octet()}.${octet()}.${octet()}`
}

function fromIp(ip: string): { headers: Record<string, string> } {
  return { headers: { 'x-forwarded-for': ip } }
}

describe('GET /api/anon-gate/challenge', () => {
  it('returns a signed challenge and the terms state', async () => {
    const res = await anonClient().get('/api/anon-gate/challenge?purpose=doc-create')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    // The bot check itself sets no cookie (the framework's session cookie aside).
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/markoto-anon|altcha/)
    const json = await res.json() as { enabled: boolean, termsVersion: number, termsAccepted: boolean, challenge: { signature: string, parameters: { data: { purpose: string } } } }
    expect(json.enabled).toBe(true)
    expect(json.termsVersion).toBe(TOS_VERSION)
    expect(json.termsAccepted).toBe(false)
    expect(json.challenge.signature).toMatch(/^[0-9a-f]{64}$/)
    expect(json.challenge.parameters.data.purpose).toBe('doc-create')
  })

  it('refuses an unknown purpose', async () => {
    expect((await anonClient().get('/api/anon-gate/challenge?purpose=nope')).status).toBe(400)
  })
})

describe('POST /api/docs — anonymous gate', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('without terms acceptance: 403 terms-required, nothing created', async () => {
    const client = anonClient()
    const res = await client.post('/api/docs', { altcha: await solveAnonChallenge(client) })
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('anon-gate/terms-required')
    expect((await testDb().query('SELECT 1 FROM documents')).rowCount).toBe(0)
  })

  it('without a bot-check solution: 403 bot-check-required', async () => {
    const res = await anonClient().post('/api/docs', { acceptTerms: true })
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('anon-gate/bot-check-required')
  })

  it('with a garbage / forged / wrong solution: 403 bot-check-failed', async () => {
    const client = anonClient()
    for (const altcha of ['garbage', Buffer.from('{"challenge":{},"solution":{}}').toString('base64')]) {
      const res = await client.post('/api/docs', { acceptTerms: true, altcha })
      expect(res.status).toBe(403)
      expect(await code(res)).toBe('anon-gate/bot-check-failed')
    }
    // Signed with another key (a self-made challenge).
    const foreign = await createAnonChallenge(deriveAltchaSecrets('not-the-server-key-but-long-enough-x'), 'doc-create', TEST_DIFFICULTY)
    const solution = await solveChallenge({ challenge: foreign, deriveKey })
    expect(solution).not.toBeNull()
    if (!solution) return
    const res = await client.post('/api/docs', { acceptTerms: true, altcha: encodeAltchaPayload(foreign, solution) })
    expect(await code(res)).toBe('anon-gate/bot-check-failed')
  })

  it('a solution for another purpose is refused', async () => {
    const client = anonClient()
    const res = await client.post('/api/docs', { acceptTerms: true, altcha: await solveAnonChallenge(client, 'abuse-report') })
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('anon-gate/bot-check-failed')
  })

  it('an expired challenge is refused with bot-check-expired', async () => {
    const secrets = deriveAltchaSecrets(TEST_ALTCHA_HMAC_KEY)
    const old = await createAnonChallenge(secrets, 'doc-create', TEST_DIFFICULTY, Date.now() - 21 * 60_000)
    const solution = await solveChallenge({ challenge: old, deriveKey })
    if (!solution) throw new Error('unsolved')
    const res = await anonClient().post('/api/docs', { acceptTerms: true, altcha: encodeAltchaPayload(old, solution) })
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('anon-gate/bot-check-expired')
  })

  it('a solution works once: the replay is refused', async () => {
    const client = anonClient()
    const fields = await anonGateFields(client)
    expect((await client.post('/api/docs', fields)).status).toBe(200)
    const replay = await anonClient().post('/api/docs', fields)
    expect(replay.status).toBe(403)
    expect(await code(replay)).toBe('anon-gate/bot-check-replayed')
  })

  it('records the accepted terms version + time on the document', async () => {
    const before = Date.now()
    const res = await createAnonDoc(anonClient())
    expect(res.status).toBe(200)
    const { docId } = await res.json() as { docId: string }
    const row = await docRow(docId)
    expect(row.owner_id).toBeNull()
    expect(row.anon_terms_version).toBe(TOS_VERSION)
    expect(row.anon_terms_accepted_at?.getTime()).toBeGreaterThanOrEqual(before - 1000)
  })

  it('remembers the acceptance in this browser (httpOnly cookie), keeping its time', async () => {
    const client = anonClient()
    const first = await createAnonDoc(client)
    expect(first.status).toBe(200)
    expect(client.cookieHeader()).toContain('markoto-anon-terms=')
    const { docId: firstId } = await first.json() as { docId: string }

    const challenge = await client.get('/api/anon-gate/challenge?purpose=doc-create')
    expect((await challenge.json() as { termsAccepted: boolean }).termsAccepted).toBe(true)

    // Second document: fresh bot check, no checkbox.
    const second = await client.post('/api/docs', { altcha: await solveAnonChallenge(client) })
    expect(second.status).toBe(200)
    const { docId: secondId } = await second.json() as { docId: string }
    expect((await docRow(secondId)).anon_terms_accepted_at?.getTime()).toBe((await docRow(firstId)).anon_terms_accepted_at?.getTime())

    // Another browser has to accept for itself.
    const other = await anonClient().post('/api/docs', { altcha: await solveAnonChallenge(anonClient()) })
    expect(await code(other)).toBe('anon-gate/terms-required')
  })

  it('a forged acceptance cookie does not count', async () => {
    const client = anonClient()
    client.setCookie(`markoto-anon-terms=v1.${TOS_VERSION}.${Date.now()}.${'a'.repeat(64)}`)
    const res = await client.post('/api/docs', { altcha: await solveAnonChallenge(client) })
    expect(await code(res)).toBe('anon-gate/terms-required')
  })

  it('validates the body before burning the solution', async () => {
    const client = anonClient()
    const fields = await anonGateFields(client)
    expect((await client.post('/api/docs', { ...fields, audience: 'nonsense' })).status).toBe(400)
    expect((await client.post('/api/docs', fields)).status).toBe(200)
  })

  it('signed-in users are not gated', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/docs', {})
    expect(res.status).toBe(200)
    const { docId } = await res.json() as { docId: string }
    const row = await docRow(docId)
    expect(row.owner_id).toBe(user.id)
    expect(row.anon_terms_version).toBeNull()
  })
})

describe('anonymous creation rate limit (enforced on the billing-off server)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it(`allows ${ANON_DOC_CREATE_LIMITS[0]?.max} per hour per client, then 429; signed-in creation is exempt`, async () => {
    const max = ANON_DOC_CREATE_LIMITS[0]?.max ?? 0
    const ip = randomTestIp()
    const client: TestClient = anonClient(TEST_BILLING_OFF_BASE_URL)
    for (let i = 0; i < max; i++) {
      const res = await createAnonDoc(client, {}, fromIp(ip))
      expect(res.status, `create #${i + 1}`).toBe(200)
    }
    const limited = await createAnonDoc(client, {}, fromIp(ip))
    expect(limited.status).toBe(429)
    expect(await code(limited)).toBe('docs/rate-limited')

    // Another client key is unaffected.
    expect((await createAnonDoc(anonClient(TEST_BILLING_OFF_BASE_URL), {}, fromIp(randomTestIp()))).status).toBe(200)

    // Signed-in creation from the same address is exempt.
    const user = await createUser()
    const signedIn = await loggedInClient(user.id, user.name, TEST_BILLING_OFF_BASE_URL)
    expect((await signedIn.post('/api/docs', {}, fromIp(ip))).status).toBe(200)
  })
})
