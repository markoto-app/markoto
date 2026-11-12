import { describe, it, expect } from 'vitest'
import { solveChallenge } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2'
import {
  CHALLENGE_TTL_SECONDS,
  PRODUCTION_DIFFICULTY,
  TEST_DIFFICULTY,
  createAnonChallenge,
  deriveAltchaSecrets,
  deriveTermsCookieSecret,
  parseAltchaPayload,
  verifyAnonSolution,
  type ReplayStore
} from '../../../server/utils/anonGate/altcha'
import { readTermsCookie, signTermsCookie } from '../../../server/utils/anonGate/termsCookie'
import {
  ANON_GATE_PURPOSES,
  isAnonGatePurpose,
  resolveAnonDocTtlDays,
  resolveAnonGateEnabled
} from '../../../shared/config/anonGate'
import { ANON_ABUSE_REPORT_LIMITS, ANON_DOC_CREATE_LIMITS } from '../../../shared/config/anonLimits'
import { encodeAltchaPayload } from '../../../app/utils/platform/altchaSolver'
import { toSolverChallenge } from '../../helpers/altcha'

// Pure cores of the anonymous gate (server/utils/anonGate/): config
// resolution, the self-hosted ALTCHA challenge/verify round trip incl.
// replay protection, and the remembered-terms cookie.

const MASTER = 'unit-test-altcha-master-key-0123456789abcdef'
const secrets = deriveAltchaSecrets(MASTER)

function memoryStore(): ReplayStore & { ids: Set<string> } {
  const ids = new Set<string>()
  return {
    ids,
    async claimOnce(id) {
      if (ids.has(id)) return false
      ids.add(id)
      return true
    }
  }
}

async function solvedPayload(purpose: 'doc-create' | 'abuse-report' = 'doc-create', now = Date.now()) {
  const challenge = await createAnonChallenge(secrets, purpose, TEST_DIFFICULTY, now)
  const solution = await solveChallenge({ challenge, deriveKey })
  if (!solution) throw new Error('test challenge did not solve')
  return { challenge, solution, payload: encodeAltchaPayload(toSolverChallenge(challenge), solution) }
}

describe('resolveAnonGateEnabled', () => {
  it('follows the legal surfaces when unset (hosted on, self-host off)', () => {
    expect(resolveAnonGateEnabled({})).toBe(false)
    expect(resolveAnonGateEnabled({ NUXT_LEGAL_SURFACES_ENABLED: 'true' })).toBe(true)
  })

  it('an explicit value wins both ways', () => {
    expect(resolveAnonGateEnabled({ NUXT_ANON_GATE_ENABLED: 'true' })).toBe(true)
    expect(resolveAnonGateEnabled({ NUXT_ANON_GATE_ENABLED: 'false', NUXT_LEGAL_SURFACES_ENABLED: 'true' })).toBe(false)
    expect(resolveAnonGateEnabled({ NUXT_ANON_GATE_ENABLED: '  ', NUXT_LEGAL_SURFACES_ENABLED: 'true' })).toBe(true)
  })
})

describe('resolveAnonDocTtlDays', () => {
  it('defaults to exactly 30 days (what the Terms state)', () => {
    expect(resolveAnonDocTtlDays({})).toBe(30)
  })
  it('accepts a non-negative integer, 0 = never; garbage fails boot', () => {
    expect(resolveAnonDocTtlDays({ NUXT_INACTIVE_DOC_TTL_DAYS: '90' })).toBe(90)
    expect(resolveAnonDocTtlDays({ NUXT_INACTIVE_DOC_TTL_DAYS: '0' })).toBe(0)
    expect(() => resolveAnonDocTtlDays({ NUXT_INACTIVE_DOC_TTL_DAYS: 'soon' })).toThrow(/NUXT_INACTIVE_DOC_TTL_DAYS/)
  })
})

describe('anonymous rate limits', () => {
  it('doc creation: 10 per hour and 30 per day', () => {
    expect(ANON_DOC_CREATE_LIMITS.map(l => [l.max, l.windowMs])).toEqual([[10, 3_600_000], [30, 86_400_000]])
  })
  it('reports: 5 per hour and 20 per day', () => {
    expect(ANON_ABUSE_REPORT_LIMITS.map(l => [l.max, l.windowMs])).toEqual([[5, 3_600_000], [20, 86_400_000]])
  })
  it('namespaces are unique', () => {
    const ns = [...ANON_DOC_CREATE_LIMITS, ...ANON_ABUSE_REPORT_LIMITS].map(l => l.namespace)
    expect(new Set(ns).size).toBe(ns.length)
  })
})

describe('purposes', () => {
  it('recognises exactly the declared purposes', () => {
    for (const p of ANON_GATE_PURPOSES) expect(isAnonGatePurpose(p)).toBe(true)
    expect(isAnonGatePurpose('anything')).toBe(false)
    expect(isAnonGatePurpose(undefined)).toBe(false)
  })
})

describe('deriveAltchaSecrets', () => {
  it('derives distinct sub-keys per use', () => {
    const cookie = deriveTermsCookieSecret(MASTER)
    expect(new Set([secrets.challengeSecret, secrets.keySecret, cookie]).size).toBe(3)
    expect(secrets.challengeSecret).not.toContain(MASTER)
  })
})

describe('createAnonChallenge', () => {
  it('is a signed PBKDF2 challenge with purpose and a 20-minute expiry', async () => {
    const now = Date.UTC(2026, 10, 3, 12, 0, 0)
    const challenge = await createAnonChallenge(secrets, 'doc-create', TEST_DIFFICULTY, now)
    expect(challenge.signature).toMatch(/^[0-9a-f]{64}$/)
    expect(challenge.parameters.algorithm).toBe('PBKDF2/SHA-256')
    expect(challenge.parameters.data).toEqual({ purpose: 'doc-create' })
    expect(challenge.parameters.expiresAt).toBe(now / 1000 + CHALLENGE_TTL_SECONDS)
    expect(challenge.parameters.keySignature).toMatch(/^[0-9a-f]{64}$/)
  })

  it('production difficulty is real work; test difficulty stays cheap', () => {
    expect(PRODUCTION_DIFFICULTY.cost * PRODUCTION_DIFFICULTY.counterMin).toBeGreaterThan(1_000_000)
    expect(TEST_DIFFICULTY.cost * TEST_DIFFICULTY.counterMax).toBeLessThan(10_000)
  })
})

describe('verifyAnonSolution', () => {
  it('accepts a correct solution once, then reports a replay', async () => {
    const store = memoryStore()
    const { payload } = await solvedPayload()
    expect(await verifyAnonSolution(payload, 'doc-create', secrets, store)).toEqual({ ok: true })
    expect(await verifyAnonSolution(payload, 'doc-create', secrets, store)).toEqual({ ok: false, reason: 'replayed' })
    expect(store.ids.size).toBe(1)
  })

  it('reports a missing or malformed payload', async () => {
    const store = memoryStore()
    expect(await verifyAnonSolution(undefined, 'doc-create', secrets, store)).toEqual({ ok: false, reason: 'missing' })
    expect(await verifyAnonSolution('', 'doc-create', secrets, store)).toEqual({ ok: false, reason: 'missing' })
    expect(await verifyAnonSolution('not-base64-json', 'doc-create', secrets, store)).toEqual({ ok: false, reason: 'malformed' })
    expect(await verifyAnonSolution(42, 'doc-create', secrets, store)).toEqual({ ok: false, reason: 'malformed' })
    expect(store.ids.size).toBe(0)
  })

  it('rejects a wrong solution without burning the challenge', async () => {
    const store = memoryStore()
    const { challenge, solution } = await solvedPayload()
    const wrong = encodeAltchaPayload(toSolverChallenge(challenge), { counter: solution.counter + 1, derivedKey: '00'.repeat(32) })
    expect(await verifyAnonSolution(wrong, 'doc-create', secrets, store)).toEqual({ ok: false, reason: 'invalid' })
    expect(store.ids.size).toBe(0)
  })

  it('rejects a tampered challenge (signature no longer matches)', async () => {
    const store = memoryStore()
    const { challenge, solution } = await solvedPayload()
    const tampered = { ...challenge, parameters: { ...challenge.parameters, cost: 1 } }
    const payload = encodeAltchaPayload(tampered, solution)
    expect(await verifyAnonSolution(payload, 'doc-create', secrets, store)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a challenge signed with another key', async () => {
    const store = memoryStore()
    const { payload } = await solvedPayload()
    const other = deriveAltchaSecrets('another-master-key-that-is-long-enough-xx')
    expect(await verifyAnonSolution(payload, 'doc-create', other, store)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects an expired challenge', async () => {
    const store = memoryStore()
    const issuedAt = Date.now() - (CHALLENGE_TTL_SECONDS + 5) * 1000
    const { payload } = await solvedPayload('doc-create', issuedAt)
    expect(await verifyAnonSolution(payload, 'doc-create', secrets, store)).toEqual({ ok: false, reason: 'expired' })
  })

  it('binds the solution to its purpose', async () => {
    const store = memoryStore()
    const { payload } = await solvedPayload('abuse-report')
    expect(await verifyAnonSolution(payload, 'doc-create', secrets, store)).toEqual({ ok: false, reason: 'wrong-purpose' })
    expect(await verifyAnonSolution(payload, 'abuse-report', secrets, store)).toEqual({ ok: true })
  })

  it('propagates a replay-store failure (the gate fails closed)', async () => {
    const { payload } = await solvedPayload()
    const broken: ReplayStore = {
      claimOnce: () => Promise.reject(new Error('valkey down'))
    }
    await expect(verifyAnonSolution(payload, 'doc-create', secrets, broken)).rejects.toThrow('valkey down')
  })
})

describe('parseAltchaPayload', () => {
  it('keeps only the protocol fields', async () => {
    const { challenge, solution } = await solvedPayload()
    const extra = Buffer.from(JSON.stringify({
      challenge: { ...challenge, extra: 'x', parameters: { ...challenge.parameters, data: { purpose: 'doc-create', nested: { a: 1 } } } },
      solution: { ...solution, more: true }
    })).toString('base64')
    const parsed = parseAltchaPayload(extra)
    expect(parsed?.challenge.parameters.data).toEqual({ purpose: 'doc-create' })
    expect(Object.keys(parsed?.solution ?? {})).toEqual(['counter', 'derivedKey'])
  })

  it('refuses oversized input', () => {
    expect(parseAltchaPayload('a'.repeat(10_000))).toBeNull()
  })
})

describe('terms cookie', () => {
  const cookieSecret = deriveTermsCookieSecret(MASTER)
  const acceptedAt = new Date(Date.UTC(2026, 10, 1, 9, 30))

  it('round-trips version + acceptance time', () => {
    const raw = signTermsCookie(cookieSecret, { termsVersion: 3, acceptedAt })
    expect(readTermsCookie(cookieSecret, raw, 3)).toEqual({ termsVersion: 3, acceptedAt })
  })

  it('is void for another terms version (re-asks after a bump)', () => {
    const raw = signTermsCookie(cookieSecret, { termsVersion: 2, acceptedAt })
    expect(readTermsCookie(cookieSecret, raw, 3)).toBeNull()
  })

  it('rejects forged, altered or foreign-key cookies', () => {
    const raw = signTermsCookie(cookieSecret, { termsVersion: 3, acceptedAt })
    expect(readTermsCookie(cookieSecret, raw.replace('v1.3.', 'v1.4.'), 4)).toBeNull()
    expect(readTermsCookie(deriveTermsCookieSecret('other-master-key-long-enough-for-this'), raw, 3)).toBeNull()
    expect(readTermsCookie(cookieSecret, `v1.3.${acceptedAt.getTime()}.${'0'.repeat(64)}`, 3)).toBeNull()
    expect(readTermsCookie(cookieSecret, undefined, 3)).toBeNull()
    expect(readTermsCookie(cookieSecret, 'garbage', 3)).toBeNull()
  })

  it('rejects an acceptance time in the future', () => {
    const future = new Date(Date.now() + 10 * 60_000)
    const raw = signTermsCookie(cookieSecret, { termsVersion: 3, acceptedAt: future })
    expect(readTermsCookie(cookieSecret, raw, 3)).toBeNull()
  })
})
