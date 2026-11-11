import type { H3Event } from 'h3'
import { getCookie, getRequestProtocol, setCookie } from 'h3'
import * as Sentry from '@sentry/nuxt'
import { useValkey } from '../platform/valkey'
import { isTestModeEnabled } from '~~/shared/utils/security/testMode'
import { SECRET_MIN_LENGTH } from '~~/shared/utils/security/validateSecrets'
import { TOS_VERSION } from '~~/shared/legal/versions'
import {
  ANON_GATE_CODES,
  resolveAnonGateEnabled,
  type AnonGateChallengeResponse,
  type AnonGatePurpose
} from '~~/shared/config/anonGate'
import {
  PRODUCTION_DIFFICULTY,
  TEST_DIFFICULTY,
  createAnonChallenge,
  deriveAltchaSecrets,
  deriveTermsCookieSecret,
  verifyAnonSolution,
  type AnonSolutionOutcome,
  type PowDifficulty,
  type ReplayStore
} from './altcha'
import {
  ANON_TERMS_COOKIE,
  ANON_TERMS_COOKIE_MAX_AGE_SECONDS,
  ANON_TERMS_COOKIE_PATH,
  readTermsCookie,
  signTermsCookie,
  type AnonTermsAcceptance
} from './termsCookie'
import { apiError } from '../api/apiError'
import type { ApiErrorCode } from '~~/shared/api/errors'

// H3 glue around the pure ALTCHA + terms-cookie cores. Endpoints call
// `enforceAnonGate(event, body, purpose)` for anonymous callers only.
// Reads process.env per call (like billingMode / instanceConfig) so tests
// can flip the flags.

export function anonGateEnabled(): boolean {
  return resolveAnonGateEnabled(process.env)
}

/** NUXT_ALTCHA_HMAC_KEY when usable (≥ 32 chars), else null. */
function altchaMasterKey(): string | null {
  const key = process.env.NUXT_ALTCHA_HMAC_KEY?.trim() ?? ''
  return key.length >= SECRET_MIN_LENGTH ? key : null
}

function powDifficulty(): PowDifficulty {
  return isTestModeEnabled() ? TEST_DIFFICULTY : PRODUCTION_DIFFICULTY
}

/**
 * Replay store in Valkey (`SET key 1 NX EX ttl`). Errors propagate: the
 * gate fails CLOSED (an anonymous create is refused while Valkey is
 * down) — failing open would let one solution create unlimited docs.
 */
const valkeyReplayStore: ReplayStore = {
  async claimOnce(id, ttlSeconds) {
    const res = await useValkey().set(id, '1', 'EX', ttlSeconds, 'NX')
    return res === 'OK'
  }
}

function requireMasterKey(): string {
  const key = altchaMasterKey()
  if (key) return key
  throw apiError('anon-gate/misconfigured')
}

function readAcceptance(event: H3Event, key: string): AnonTermsAcceptance | null {
  return readTermsCookie(deriveTermsCookieSecret(key), getCookie(event, ANON_TERMS_COOKIE), TOS_VERSION)
}

export async function issueAnonChallenge(event: H3Event, purpose: AnonGatePurpose): Promise<AnonGateChallengeResponse> {
  if (!anonGateEnabled()) {
    return { enabled: false, termsVersion: TOS_VERSION, termsAccepted: false, challenge: null }
  }
  const key = requireMasterKey()
  const challenge = await createAnonChallenge(deriveAltchaSecrets(key), purpose, powDifficulty())
  return {
    enabled: true,
    termsVersion: TOS_VERSION,
    termsAccepted: readAcceptance(event, key) !== null,
    challenge
  }
}

const OUTCOME_CODES: Record<Exclude<AnonSolutionOutcome, { ok: true }>['reason'], ApiErrorCode> = {
  'missing': ANON_GATE_CODES.botCheckRequired,
  'malformed': ANON_GATE_CODES.botCheckFailed,
  'invalid': ANON_GATE_CODES.botCheckFailed,
  'wrong-purpose': ANON_GATE_CODES.botCheckFailed,
  'expired': ANON_GATE_CODES.botCheckExpired,
  'replayed': ANON_GATE_CODES.botCheckReplayed
}

/** Verify + burn the ALTCHA solution, or throw 403 (503 when Valkey is down). */
export async function requireBotCheck(event: H3Event, raw: unknown, purpose: AnonGatePurpose): Promise<void> {
  const key = requireMasterKey()
  let outcome: AnonSolutionOutcome
  try {
    outcome = await verifyAnonSolution(raw, purpose, deriveAltchaSecrets(key), valkeyReplayStore)
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'anonGate', event: 'replay_store_unavailable' } })
    throw apiError('anon-gate/unavailable', undefined, { cause: e })
  }
  if (outcome.ok) return
  // Every outcome code is a 403 without params.
  throw (apiError as (c: ApiErrorCode) => Error)(OUTCOME_CODES[outcome.reason])
}

/**
 * The terms acceptance backing this request: a fresh `acceptTerms: true`
 * (then the cookie is set) or a valid remembered one. Throws 403
 * `anon-gate/terms-required` otherwise.
 */
function requireTermsAcceptance(event: H3Event, acceptTerms: unknown): AnonTermsAcceptance {
  const key = requireMasterKey()
  const remembered = readAcceptance(event, key)
  if (acceptTerms === true) {
    // A remembered acceptance of the same version keeps its original time.
    const acceptance = remembered ?? { termsVersion: TOS_VERSION, acceptedAt: new Date() }
    setCookie(event, ANON_TERMS_COOKIE, signTermsCookie(deriveTermsCookieSecret(key), acceptance), {
      httpOnly: true,
      sameSite: 'strict',
      secure: getRequestProtocol(event) === 'https',
      path: ANON_TERMS_COOKIE_PATH,
      maxAge: ANON_TERMS_COOKIE_MAX_AGE_SECONDS
    })
    return acceptance
  }
  if (remembered) return remembered
  throw apiError('anon-gate/terms-required')
}

export interface AnonGateInput {
  altcha?: unknown
  acceptTerms?: unknown
}

/**
 * Full gate for an ANONYMOUS caller: terms first (cheap, no state), then
 * the bot check (burns the solution). Returns the acceptance to record,
 * or null when the gate is off on this instance.
 */
export async function enforceAnonGate(
  event: H3Event,
  input: AnonGateInput,
  purpose: AnonGatePurpose
): Promise<AnonTermsAcceptance | null> {
  if (!anonGateEnabled()) return null
  const acceptance = requireTermsAcceptance(event, input.acceptTerms)
  await requireBotCheck(event, input.altcha, purpose)
  return acceptance
}
