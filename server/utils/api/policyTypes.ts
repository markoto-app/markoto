import type { H3Event } from 'h3'
import type { requireValidatedUserSession } from '../auth/validatedSession'
import type { SsoConnectionRow } from '../../repos/sso'

// Types shared by the access policies (`./policy.ts`, `./policyDoc.ts`,
// `./policyWorkspace.ts`) and the wrapper.

export type ValidatedUser = Awaited<ReturnType<typeof requireValidatedUserSession>>['user']

export type PolicyKind = 'public' | 'user' | 'admin' | 'workspace' | 'doc' | 'internal' | 'scim' | 'test-only' | 'custom'
const POLICY_KINDS: readonly PolicyKind[] = ['public', 'user', 'admin', 'workspace', 'doc', 'internal', 'scim', 'test-only', 'custom']

export interface AdminIdentity { userId: number, name: string, email: string }

/**
 * What the gate step established for THIS request. Policies are module-level
 * singletons shared by concurrent requests, so anything `gate` learns must
 * travel here, never in a closure variable.
 */
export interface PolicyGate {
  user: ValidatedUser | null
  admin?: AdminIdentity
  scimConnection?: SsoConnectionRow
}

/** What `resolve` sees: the parsed inputs (or the raw values when a route declares no schema). */
export interface ResolveInput {
  params: Record<string, unknown> | undefined
  query: Record<string, unknown> | undefined
  body: unknown
}

export interface PolicyDescriptor {
  readonly kind: PolicyKind
  /** Reachable without a session: the route must be on the public allowlist. */
  readonly sessionless: boolean
  readonly reason?: string
  /** `doc` / `workspace` policies: the level required. */
  readonly need?: string
}

export interface Policy<Ctx> extends PolicyDescriptor {
  /** First step: session and service credentials, before input is parsed. */
  gate(event: H3Event): Promise<PolicyGate>
  /** Second step: object-level resolution, after params, query and body are parsed. */
  resolve(event: H3Event, gate: PolicyGate, input: ResolveInput): Promise<Ctx>
}

/** True for a policy object built by `allow.*` (fail closed on anything else). */
export function isPolicy(value: unknown): value is Policy<unknown> {
  const p = value as Partial<Policy<unknown>> | null
  return !!p && typeof p === 'object' && POLICY_KINDS.includes(p.kind as PolicyKind)
    && typeof p.gate === 'function' && typeof p.resolve === 'function' && typeof p.sessionless === 'boolean'
}
