import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { anonClient, loggedInClient, type TestClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'
import { TEST_BILLING_OFF_BASE_URL } from '../setup/env'
import { DOC_TOKEN_ADDRESS_LIMIT, DOC_TOKEN_CALLER_LIMIT } from '../../../shared/config/docTokenLimits'

// GET /api/docs/:id/token rate limits (shared/config/docTokenLimits.ts),
// enforced on the billing-off server (setup/env.ts). Every test sends its own
// X-Forwarded-For address: the client key the limits are counted on. An
// office behind one NAT address must not run out because one person (or the
// anonymous visitors) used the budget; probing ids stays throttled per address.

function randomTestIp(): string {
  const octet = () => Math.floor(Math.random() * 250) + 1
  return `198.${octet()}.${octet()}.${octet()}`
}

async function code(res: Response): Promise<string | undefined> {
  return (await res.json() as { data?: { code?: string } }).data?.code
}

async function tokens(client: TestClient, path: string, n: number, ip: string): Promise<number[]> {
  const statuses: number[] = []
  for (let i = 0; i < n; i++) {
    statuses.push((await client.get(path, { headers: { 'x-forwarded-for': ip } })).status)
  }
  return statuses
}

describe('GET /api/docs/:docId/token: rate limits', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('a signed-in user has a budget of their own: one user at the limit does not block a colleague at the same address', async () => {
    const ip = randomTestIp()
    const doc = await createDoc({ accessMode: 'open-edit' })
    const alice = await loggedInClient((await createUser()).id, 'Alice', TEST_BILLING_OFF_BASE_URL)
    const bob = await loggedInClient((await createUser()).id, 'Bob', TEST_BILLING_OFF_BASE_URL)
    const path = `/api/docs/${doc.docId}/token`

    expect(await tokens(alice, path, DOC_TOKEN_CALLER_LIMIT.max, ip)).toEqual(Array(DOC_TOKEN_CALLER_LIMIT.max).fill(200))
    const limited = await alice.get(path, { headers: { 'x-forwarded-for': ip } })
    expect(limited.status).toBe(429)
    expect(await code(limited)).toBe('rate/limited')

    // Same address, other account: unaffected.
    expect((await bob.get(path, { headers: { 'x-forwarded-for': ip } })).status).toBe(200)
  })

  it('anonymous callers share one budget per address, apart from signed-in users', async () => {
    const ip = randomTestIp()
    const doc = await createDoc({ accessMode: 'open-edit' })
    const anon = anonClient(TEST_BILLING_OFF_BASE_URL)
    const path = `/api/docs/${doc.docId}/token`

    expect(await tokens(anon, path, DOC_TOKEN_CALLER_LIMIT.max, ip)).toEqual(Array(DOC_TOKEN_CALLER_LIMIT.max).fill(200))
    expect((await anonClient(TEST_BILLING_OFF_BASE_URL).get(path, { headers: { 'x-forwarded-for': ip } })).status).toBe(429)
    // Another address is a separate budget, and so is a signed-in user here.
    expect((await anon.get(path, { headers: { 'x-forwarded-for': randomTestIp() } })).status).toBe(200)
    const carol = await loggedInClient((await createUser()).id, 'Carol', TEST_BILLING_OFF_BASE_URL)
    expect((await carol.get(path, { headers: { 'x-forwarded-for': ip } })).status).toBe(200)
  })

  it('the per-address ceiling counts every request, unknown document ids included', async () => {
    const ip = randomTestIp()
    const anon = anonClient(TEST_BILLING_OFF_BASE_URL)
    const statuses = await tokens(anon, '/api/docs/does-not-exist/token', DOC_TOKEN_ADDRESS_LIMIT.max, ip)
    expect(statuses).toEqual(Array(DOC_TOKEN_ADDRESS_LIMIT.max).fill(404))

    // The address is spent: a real document, even for a signed-in user, waits.
    const doc = await createDoc({ accessMode: 'open-edit' })
    const dave = await loggedInClient((await createUser()).id, 'Dave', TEST_BILLING_OFF_BASE_URL)
    const res = await dave.get(`/api/docs/${doc.docId}/token`, { headers: { 'x-forwarded-for': ip } })
    expect(res.status).toBe(429)
  })
})
