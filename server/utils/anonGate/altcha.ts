import { createHmac } from 'node:crypto'
import { createChallenge, randomInt, verifySolution, type Challenge, type Solution } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2'
import type { AnonGatePurpose } from '~~/shared/config/anonGate'

// Self-hosted ALTCHA (proof of work), run inside the Nitro server with
// `altcha-lib` (MIT). No third-party service, no cookie, no tracking:
//
//   challenge  GET /api/anon-gate/challenge → createAnonChallenge()
//   solve      the browser solves it in a bundled web worker
//              (app/workers/altchaPbkdf2.worker.ts)
//   verify     verifyAnonSolution() on the endpoint that is gated
//
// Why not the ALTCHA Sentinel container: Sentinel is ALTCHA's
// commercial server (30-day trial, then a paid licence; multi-replica
// needs a Pro licence), so it can't be the default of an open-source
// stack. The protocol itself is open — this file is the server side of
// it, with the same HMAC-signed, expiring v2 challenges.
//
// Design:
//   - PBKDF2/SHA-256, deterministic mode: the server derives the key for
//     a random counter once and signs it (`keySignature`), so verifying
//     costs one HMAC instead of a PBKDF2 run.
//   - The challenge carries `data.purpose` (signed), so a solution for
//     doc creation can't be spent on an abuse report and vice versa.
//   - Expiry 20 min (the visitor reads the terms while the worker
//     solves); replay protection: the challenge signature is claimed
//     once in Valkey until shortly after expiry (`claimOnce`).
//   - Keys: one secret `NUXT_ALTCHA_HMAC_KEY`; per-use sub-keys are
//     HMAC-derived with fixed labels (challenge signature, key
//     signature, terms cookie), so a value signed for one use can never
//     verify for another.

export const ALTCHA_ALGORITHM = 'PBKDF2/SHA-256'
export const CHALLENGE_TTL_SECONDS = 20 * 60

/**
 * Work per challenge. Production: ~0.5 ms per attempt, 2 000–5 000
 * attempts → around a second on a phone split across the worker pool,
 * invisible while the visitor reads the dialog; noticeably expensive for
 * a script creating thousands of documents. Test mode uses a tiny but
 * REAL challenge (the flow + integration suites solve it for real).
 */
export interface PowDifficulty {
  cost: number
  counterMin: number
  counterMax: number
}

export const PRODUCTION_DIFFICULTY: PowDifficulty = Object.freeze({ cost: 2_000, counterMin: 2_000, counterMax: 5_000 })
export const TEST_DIFFICULTY: PowDifficulty = Object.freeze({ cost: 100, counterMin: 10, counterMax: 60 })

export interface AltchaSecrets {
  challengeSecret: string
  keySecret: string
}

function subKey(master: string, label: string): string {
  return createHmac('sha256', master).update(label).digest('hex')
}

/** Derive the per-use secrets from the master key. */
export function deriveAltchaSecrets(masterKey: string): AltchaSecrets {
  return {
    challengeSecret: subKey(masterKey, 'markoto:altcha:challenge:v1'),
    keySecret: subKey(masterKey, 'markoto:altcha:key:v1')
  }
}

/** Secret for the remembered-acceptance cookie (same master, own label). */
export function deriveTermsCookieSecret(masterKey: string): string {
  return subKey(masterKey, 'markoto:anon-terms-cookie:v1')
}

export async function createAnonChallenge(
  secrets: AltchaSecrets,
  purpose: AnonGatePurpose,
  difficulty: PowDifficulty,
  now: number = Date.now()
): Promise<Challenge> {
  return createChallenge({
    algorithm: ALTCHA_ALGORITHM,
    cost: difficulty.cost,
    counter: randomInt(difficulty.counterMax, difficulty.counterMin),
    deriveKey,
    data: { purpose },
    expiresAt: Math.floor(now / 1000) + CHALLENGE_TTL_SECONDS,
    hmacSignatureSecret: secrets.challengeSecret,
    hmacKeySignatureSecret: secrets.keySecret
  })
}

/** Claims an id once; false when it was claimed before. Throws when the store is down. */
export interface ReplayStore {
  claimOnce: (id: string, ttlSeconds: number) => Promise<boolean>
}

export type AnonSolutionOutcome
  = | { ok: true }
    | { ok: false, reason: 'missing' | 'malformed' | 'invalid' | 'expired' | 'wrong-purpose' | 'replayed' }

interface ParsedPayload {
  challenge: Challenge
  solution: Solution
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse the client's payload: base64 of `{"challenge": …, "solution": …}`
 * (the ALTCHA widget's v2 payload shape). Structural checks only — the
 * signature check in `verifySolution` is what makes it trustworthy.
 */
export function parseAltchaPayload(raw: unknown): ParsedPayload | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8_192) return null
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (!isRecord(decoded) || !isRecord(decoded.challenge) || !isRecord(decoded.solution)) return null
  const challenge = decoded.challenge
  const solution = decoded.solution
  const parameters = challenge.parameters
  if (!isRecord(parameters) || typeof challenge.signature !== 'string') return null
  if (typeof parameters.algorithm !== 'string' || typeof parameters.nonce !== 'string'
    || typeof parameters.salt !== 'string' || typeof parameters.cost !== 'number'
    || typeof parameters.keyLength !== 'number' || typeof parameters.keyPrefix !== 'string') {
    return null
  }
  if (typeof solution.counter !== 'number' || typeof solution.derivedKey !== 'string') return null
  const data = parameters.data
  const cleanData: Record<string, string | number | boolean | null> = {}
  if (isRecord(data)) {
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) cleanData[k] = v
    }
  }
  return {
    challenge: {
      signature: challenge.signature,
      parameters: {
        algorithm: parameters.algorithm,
        nonce: parameters.nonce,
        salt: parameters.salt,
        cost: parameters.cost,
        keyLength: parameters.keyLength,
        keyPrefix: parameters.keyPrefix,
        ...(typeof parameters.keySignature === 'string' ? { keySignature: parameters.keySignature } : {}),
        ...(typeof parameters.expiresAt === 'number' ? { expiresAt: parameters.expiresAt } : {}),
        ...(isRecord(data) ? { data: cleanData } : {})
      }
    },
    solution: { counter: solution.counter, derivedKey: solution.derivedKey }
  }
}

/**
 * Verify a solution for `purpose` and burn it. Order matters: only a
 * correct, signed, unexpired solution for this purpose is claimed in the
 * replay store, so garbage can't fill it.
 */
export async function verifyAnonSolution(
  raw: unknown,
  purpose: AnonGatePurpose,
  secrets: AltchaSecrets,
  store: ReplayStore,
  now: number = Date.now()
): Promise<AnonSolutionOutcome> {
  if (raw === undefined || raw === null || raw === '') return { ok: false, reason: 'missing' }
  const parsed = parseAltchaPayload(raw)
  if (!parsed) return { ok: false, reason: 'malformed' }
  const { challenge, solution } = parsed
  if (challenge.parameters.algorithm !== ALTCHA_ALGORITHM) return { ok: false, reason: 'invalid' }
  // A challenge without an expiry would be reusable until the replay
  // entry vanished; ours always carry one.
  const expiresAt = challenge.parameters.expiresAt
  if (typeof expiresAt !== 'number') return { ok: false, reason: 'invalid' }
  if (expiresAt < now / 1000) return { ok: false, reason: 'expired' }

  let result
  try {
    result = await verifySolution({
      challenge,
      solution,
      deriveKey,
      hmacSignatureSecret: secrets.challengeSecret,
      hmacKeySignatureSecret: secrets.keySecret
    })
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (result.expired) return { ok: false, reason: 'expired' }
  if (!result.verified) return { ok: false, reason: 'invalid' }
  // Signed field — only checked after the signature held.
  if (challenge.parameters.data?.purpose !== purpose) return { ok: false, reason: 'wrong-purpose' }

  const ttl = Math.max(1, Math.ceil(expiresAt - now / 1000) + 60)
  const fresh = await store.claimOnce(`altcha:used:${challenge.signature}`, ttl)
  return fresh ? { ok: true } : { ok: false, reason: 'replayed' }
}
