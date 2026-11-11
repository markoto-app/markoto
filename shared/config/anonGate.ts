// Anonymous-creation gate: what an anonymous visitor must do before a
// document is created for them (and before an anonymous abuse report is
// accepted).
//
//   1. pass a proof-of-work bot check (ALTCHA, solved invisibly in a web
//      worker; challenge + verification run in our own server — see
//      server/utils/anonGate/altcha.ts), and
//   2. accept the Terms + Acceptable Use rules and confirm they are at
//      least 16 (once per browser and terms version; remembered in a
//      signed first-party cookie).
//
// Signed-in users are never gated: they accepted the terms at onboarding.
//
//   | Shape                  | NUXT_ANON_GATE_ENABLED | effective        |
//   |------------------------|------------------------|------------------|
//   | Hosted SaaS            | (unset)                | on (legal on)    |
//   | Self-hosted (default)  | (unset)                | off (legal off)  |
//   | Either                 | true / false           | as set           |
//
// Pure — takes an env-shaped record so every test tier can drive it.

import { parseBooleanFlag } from './billingMode'

type Env = Record<string, string | undefined>

/** Age floor confirmed in the gate (GDPR Art. 8 child-consent floor, as at onboarding). */
export const ANON_GATE_MIN_AGE = 16

/**
 * Is the gate on? An explicit `NUXT_ANON_GATE_ENABLED` wins (accepts the
 * same truthy/falsy spellings as the other flags); unset follows
 * `NUXT_LEGAL_SURFACES_ENABLED` — the gate links the terms, which only
 * exist where the legal surfaces are on.
 */
export function resolveAnonGateEnabled(env: Env): boolean {
  const raw = env.NUXT_ANON_GATE_ENABLED?.trim()
  if (raw) return parseBooleanFlag(raw)
  return parseBooleanFlag(env.NUXT_LEGAL_SURFACES_ENABLED)
}

/** Default of NUXT_INACTIVE_DOC_TTL_DAYS — what the hosted Terms + privacy policy state. */
export const DEFAULT_ANON_DOC_TTL_DAYS = 30

/**
 * Inactivity period after which anonymous documents are deleted
 * (NUXT_INACTIVE_DOC_TTL_DAYS; unset → 30, `0` or invalid → 0 = never).
 * Mirrors the sweep's parser (server/utils/documents/inactiveDocSweep.ts).
 */
export function resolveAnonDocTtlDays(env: Env): number {
  const raw = env.NUXT_INACTIVE_DOC_TTL_DAYS?.trim()
  if (!raw) return DEFAULT_ANON_DOC_TTL_DAYS
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** Stable error codes the server answers with (403 unless noted). */
export const ANON_GATE_CODES = {
  /** No bot-check solution in the request. */
  botCheckRequired: 'anon-gate/bot-check-required',
  /** The solution is malformed, unsigned, tampered or wrong. */
  botCheckFailed: 'anon-gate/bot-check-failed',
  /** The challenge expired — fetch a new one. */
  botCheckExpired: 'anon-gate/bot-check-expired',
  /** The solution was already used once. */
  botCheckReplayed: 'anon-gate/bot-check-replayed',
  /** Terms + age not accepted (and no remembered acceptance for the current terms). */
  termsRequired: 'anon-gate/terms-required',
  /** 503: the gate is on but the server has no ALTCHA key. */
  misconfigured: 'anon-gate/misconfigured',
  /** 503: the replay store (Valkey) is unreachable — the gate fails closed. */
  unavailable: 'anon-gate/unavailable'
} as const

/** Codes after which the client should fetch a fresh challenge and retry once. */
export const ANON_GATE_RETRYABLE_CODES: readonly string[] = [
  ANON_GATE_CODES.botCheckExpired,
  ANON_GATE_CODES.botCheckReplayed,
  ANON_GATE_CODES.botCheckFailed
]

/** What a challenge may be spent on (signed into the challenge). */
export const ANON_GATE_PURPOSES = ['doc-create', 'abuse-report'] as const
export type AnonGatePurpose = typeof ANON_GATE_PURPOSES[number]

export function isAnonGatePurpose(value: unknown): value is AnonGatePurpose {
  return ANON_GATE_PURPOSES.some(p => p === value)
}

/** Shape of `GET /api/anon-gate/challenge`. */
export interface AnonGateChallengeResponse {
  enabled: boolean
  /** Current terms version (shared/legal/versions.ts TOS_VERSION). */
  termsVersion: number
  /** This browser already accepted the current terms version. */
  termsAccepted: boolean
  /** ALTCHA v2 challenge (null when the gate is off). */
  challenge: unknown
}
