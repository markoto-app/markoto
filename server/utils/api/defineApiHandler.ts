import type { EventHandler, EventHandlerRequest, H3Event } from 'h3'
import { createError, defineEventHandler, getQuery, getRouterParams, readBody, readRawBody } from 'h3'
import type { z, ZodType } from 'zod'
import { requireRecentLogin } from '../auth/validatedSession'
import { assertBillingEnabled } from '../billing/billingMode'
import { assertLegalSurfacesEnabled } from '../platform/instanceConfig'
import { assertPlanFeature, resolveDocPlanFor, resolveUserPlan, resolveWorkspacePlan } from '../billing/entitlements'
import { checkRateLimit } from '../platform/rateLimit'
import { getClientRateLimitKey } from '../platform/clientIp'
import { withIdempotency } from '../platform/idempotency'
import { apiError } from './apiError'
import { isPolicy, type Policy, type PolicyDescriptor, type ResolveInput } from './policyTypes'
import type { ApiErrorCode } from '~~/shared/api/errors'
import type { FieldIssue } from '~~/shared/api/errors/define'
import type { FeatureField } from '~~/shared/config/tiers'

// The handler contract (docs/contributing/api-handlers.md). Every route
// declares its access policy, its inputs as zod schemas and its unconditional
// gates; the wrapper runs them in a fixed order and hands the handler a typed
// context. Response types are still inferred by Nitro from the return value.
//
// Order, per request:
//   1. instance gate (billing / legal surfaces), test-only 404 (inside the policy gate)
//   2. policy gate: session / service credentials; `recentLogin`
//   3. params, query: safeParse → 400
//   4. body: safeParse → 400
//   5. policy resolve: object-level access → 404 / 403
//   6. plan feature
//   7. rate limits
//   8. idempotency
//   9. the handler
//
// h3's readValidatedBody / getValidatedQuery are not used: they rethrow any
// error from the validator as a 400 whose data is the raw zod error.

export type BodySpec = ZodType | 'none' | 'raw' | 'custom'

export interface RateLimitSpec<Ctx> {
  namespace: string
  max: number
  windowMs: number
  /** `user`: the signed-in user's id; `ip`: the client key (IPv4 or IPv6 /64). */
  key: 'user' | 'ip' | ((ctx: Ctx) => string)
  /** Code of the 429; default `rate/limited`. */
  error?: ApiErrorCode
}

type Out<S> = S extends ZodType ? z.output<S> : undefined
type In<S> = S extends ZodType ? z.input<S> : undefined

export type ParsedInput<P, Q, B> = {
  params: Out<P>
  query: Out<Q>
  body: Out<B>
} & (B extends 'raw' ? { rawBody: () => Promise<Buffer | undefined> } : unknown)

export interface ApiHandlerDef<Ctx, P, Q, B extends BodySpec, R> {
  access: Policy<Ctx>
  params?: P
  query?: Q
  /** A zod schema, `'none'` (default), `'raw'` (`ctx.rawBody()`), or `'custom'` (the handler reads it: multipart, size-limited readers). */
  body?: B
  /** Code for validation failures (keeps a route's existing code, e.g. `share/invalid`); default `request/invalid`. Its params must accept `field` and `fields`. */
  invalidCode?: ApiErrorCode
  instance?: 'billing' | 'legalSurfaces'
  /** Sensitive account action: sign-in at most 12 h old (401 `auth/reauth-required`). */
  recentLogin?: true
  /** Plan feature required; the plan is the workspace's (`ctx.wsId`), the document's (`ctx.doc`) or the user's. */
  plan?: { feature: FeatureField, message: string }
  rateLimit?: RateLimitSpec<Ctx> | readonly RateLimitSpec<Ctx>[]
  /** Deduplicate retries carrying an `Idempotency-Key` header (needs a signed-in user). */
  idempotency?: { scope: string }
  handler: (ctx: Ctx & ParsedInput<P, Q, B> & { event: H3Event }) => R | Promise<R>
}

/** Secret columns of server/db/schema.ts that a response must never carry. */
type SecretKey = 'passwordHash' | 'anonCreatorKeyHash' | 'tokenHash' | 'scimTokenHash' | 'litellmKeyToken'
  | 'oidcClientSecret' | 'apiKeyEncrypted' | 'confirmTokenHash' | 'unsubscribeTokenHash' | 'verifyToken'

type Leaf = string | number | boolean | bigint | symbol | null | undefined | Date | ((...args: never[]) => unknown)

/** `true` (or `boolean`) when a secret column name appears anywhere in `T` (6 levels deep). */
export type HasSecretKey<T, D extends unknown[] = []> = D['length'] extends 6
  ? false
  : T extends Leaf
    ? false
    : T extends readonly (infer E)[]
      ? HasSecretKey<E, [...D, 0]>
      : T extends object
        ? [Extract<keyof T, SecretKey>] extends [never]
            ? true extends { [K in keyof T]-?: HasSecretKey<T[K], [...D, 0]> }[keyof T] ? true : false
            : true
        : false

export type ApiEventHandler<R, I> = EventHandler<EventHandlerRequest, Promise<R>> & {
  /** Phantom: the request input types, read by the generated client types (`modules/api-contract.ts`). */
  readonly '~input'?: I
  /** The declared policy (route tests). */
  readonly '~access': PolicyDescriptor
}

function fieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((i) => {
    const issue = i as { code: string, path: PropertyKey[], minimum?: unknown, maximum?: unknown, format?: unknown, expected?: unknown }
    const out: FieldIssue = { path: issue.path.map(String).join('.'), issue: issue.code }
    if (typeof issue.minimum === 'number' || typeof issue.minimum === 'bigint') out.minimum = issue.minimum
    if (typeof issue.maximum === 'number' || typeof issue.maximum === 'bigint') out.maximum = issue.maximum
    if (typeof issue.format === 'string') out.format = issue.format
    if (typeof issue.expected === 'string') out.expected = issue.expected
    return out
  })
}

function invalid(code: ApiErrorCode, fields: FieldIssue[]) {
  // The validation params (`field`, `fields`) are checked against the code's spec in test mode.
  return (apiError as (c: ApiErrorCode, p: unknown) => Error)(code, { field: fields[0]?.path ?? '', fields })
}

function parseWith<S extends ZodType>(schema: S, value: unknown, code: ApiErrorCode): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw invalid(code, fieldIssues(result.error))
  return result.data
}

const isSchema = (b: unknown): b is ZodType => typeof b === 'object' && b !== null && typeof (b as ZodType).safeParse === 'function'

function rateKey<Ctx>(spec: RateLimitSpec<Ctx>, ctx: Ctx, event: H3Event): string {
  if (typeof spec.key === 'function') return spec.key(ctx)
  if (spec.key === 'ip') return getClientRateLimitKey(event)
  const user = (ctx as { user?: { id: number } | null }).user
  // A per-user limit on a route that admitted no user is a wiring bug: refuse.
  if (!user) throw new Error(`rate limit ${spec.namespace}: key 'user' on a route without a user`)
  return String(user.id)
}

async function planFor(ctx: { wsId?: unknown, doc?: unknown, user?: { id: number } | null }) {
  if (typeof ctx.wsId === 'string') return resolveWorkspacePlan(ctx.wsId)
  if (ctx.doc) return resolveDocPlanFor(ctx.doc as { ownerId: number | null, workspaceId: string | null })
  return resolveUserPlan(ctx.user?.id ?? null)
}

const BROKEN_POLICY: PolicyDescriptor = { kind: 'custom', sessionless: false, reason: 'invalid policy' }

export function defineApiHandler<
  Ctx extends object,
  P extends ZodType | undefined = undefined,
  Q extends ZodType | undefined = undefined,
  B extends BodySpec = 'none',
  R = unknown
>(
  def: ApiHandlerDef<Ctx, P, Q, B, R>,
  ..._noSecrets: true extends HasSecretKey<Awaited<R>> ? [error: 'response exposes a secret column'] : []
): ApiEventHandler<R, { params: In<P>, query: In<Q>, body: In<B> }> {
  const invalidCode = def.invalidCode ?? 'request/invalid'
  const limits: readonly RateLimitSpec<Ctx>[] = def.rateLimit === undefined ? [] : Array.isArray(def.rateLimit) ? def.rateLimit : [def.rateLimit as RateLimitSpec<Ctx>]

  const handler = defineEventHandler(async (event): Promise<R> => {
    const access: unknown = def.access
    // Fail closed: a route whose policy isn't one of ours never runs.
    if (!isPolicy(access)) {
      console.error(`[api] ${event.path}: access is not an allow.* policy`)
      throw createError({ statusCode: 500, message: 'Route has no valid access policy' })
    }
    if (def.instance === 'billing') assertBillingEnabled()
    else if (def.instance === 'legalSurfaces') assertLegalSurfacesEnabled()

    const gate = await access.gate(event)
    if (def.recentLogin) await requireRecentLogin(event)

    const rawParams = getRouterParams(event)
    const params = def.params ? parseWith(def.params, rawParams, invalidCode) : undefined
    const query = def.query ? parseWith(def.query, getQuery(event), invalidCode) : undefined
    let body: unknown
    if (isSchema(def.body)) {
      let raw: unknown
      try {
        raw = await readBody(event)
      } catch {
        throw invalid(invalidCode, [{ path: '', issue: 'invalid_format', format: 'json' }])
      }
      body = parseWith(def.body, raw, invalidCode)
    }

    const input: ResolveInput = {
      params: (params as Record<string, unknown> | undefined) ?? rawParams,
      query: query as Record<string, unknown> | undefined,
      body
    }
    const ctx = await (access as Policy<Ctx>).resolve(event, gate, input)
    if (ctx === null || typeof ctx !== 'object') throw createError({ statusCode: 500, message: 'Access policy returned no context' })

    if (def.plan) assertPlanFeature(await planFor(ctx as never), def.plan.feature, def.plan.message)
    for (const spec of limits) {
      if (!(await checkRateLimit(spec.namespace, rateKey(spec, ctx, event), spec.max, spec.windowMs))) {
        throw (apiError as (c: ApiErrorCode) => Error)(spec.error ?? 'rate/limited')
      }
    }

    const full = {
      ...ctx,
      params,
      query,
      body,
      event,
      ...(def.body === 'raw' ? { rawBody: () => readRawBody(event, false) } : {})
    } as unknown as Ctx & ParsedInput<P, Q, B> & { event: H3Event }
    const run = async () => def.handler(full)
    if (def.idempotency) {
      const user = (ctx as { user?: { id: number } | null }).user
      if (!user) throw new Error('idempotency needs a signed-in user')
      return withIdempotency(event, def.idempotency.scope, user.id, run)
    }
    return run()
  })

  const descriptor: PolicyDescriptor = isPolicy(def.access)
    ? { kind: def.access.kind, sessionless: def.access.sessionless, reason: def.access.reason, need: def.access.need }
    : BROKEN_POLICY
  return Object.assign(handler, { '~access': descriptor }) as unknown as ApiEventHandler<R, { params: In<P>, query: In<Q>, body: In<B> }>
}
