import { solveChallenge, type Challenge } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2'
import type { TestClient } from './client'
import type { AnonGatePurpose } from '../../../shared/config/anonGate'
import { parseAltchaPayload } from '../../../server/utils/anonGate/altcha'

// The test servers run the anonymous gate for real (legal surfaces on):
// an anonymous POST /api/docs needs a fresh ALTCHA solution + the terms
// acceptance. These helpers do what the browser does, fetch a challenge
// from the server and solve it (test difficulty, a few ms), so the suite
// exercises the real verification path instead of bypassing it.

function isChallenge(value: unknown): value is Challenge {
  if (typeof value !== 'object' || value === null) return false
  // Round-trip through the server's own payload parser: same structural
  // checks the endpoint applies.
  const encoded = Buffer.from(JSON.stringify({ challenge: value, solution: { counter: 0, derivedKey: '00' } })).toString('base64')
  return parseAltchaPayload(encoded) !== null
}

/** Fetch a challenge for `purpose` and return a solved, single-use payload. */
export async function solveAnonChallenge(client: TestClient, purpose: AnonGatePurpose = 'doc-create'): Promise<string> {
  const res = await client.get(`/api/anon-gate/challenge?purpose=${purpose}`)
  if (!res.ok) throw new Error(`[anonGate] challenge returned ${res.status}: ${await res.text()}`)
  const json: unknown = await res.json()
  const challenge = typeof json === 'object' && json !== null && 'challenge' in json ? json.challenge : null
  if (!isChallenge(challenge)) throw new Error('[anonGate] the server sent no challenge (is the gate on?)')
  const solution = await solveChallenge({ challenge, deriveKey })
  if (!solution) throw new Error('[anonGate] challenge did not solve')
  return Buffer.from(JSON.stringify({ challenge, solution: { counter: solution.counter, derivedKey: solution.derivedKey } })).toString('base64')
}

/** Body fields an anonymous creator sends: a fresh solution + the terms tick. */
export async function anonGateFields(client: TestClient): Promise<{ altcha: string, acceptTerms: true }> {
  return { altcha: await solveAnonChallenge(client, 'doc-create'), acceptTerms: true }
}

/** Anonymous document creation through the gate (what the browser does). */
export async function createAnonDoc(
  client: TestClient,
  body: Record<string, unknown> = {},
  opts: { headers?: Record<string, string> } = {}
): Promise<Response> {
  return client.post('/api/docs', { ...body, ...(await anonGateFields(client)) }, opts)
}
