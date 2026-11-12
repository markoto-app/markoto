import type { EventHandler, EventHandlerRequest, H3Event } from 'h3'
import { createError, defineEventHandler, getQuery, getRouterParams, readBody, readRawBody, setHeader, setResponseStatus } from 'h3'
import type { z, ZodType } from 'zod'
import { requireRecentLogin } from '../auth/validatedSession'
import { assertBillingEnabled } from '../billing/billingMode'
import { assertLegalSurfacesEnabled } from '../platform/instanceConfig'
import { customDomainSettings } from '../customDomains/config'
import { assertPlanFeature, resolveDocPlanFor, resolveUserPlan, resolveWorkspacePlan } from '../billing/entitlements'
import { checkRateLimit } from '../platform/rateLimit'
import { getClientRateLimitKey } from '../platform/clientIp'
import { withIdempotency } from '../platform/idempotency'
import { apiError } from './apiError'
import { isPolicy, type ErrorFormat, type Policy, type PolicyDescriptor, type ResolveInput } from './policyTypes'
import type { ApiErrorCode } from '~~/shared/api/errors'
import type { FieldIssue } from '~~/shared/api/errors/define'
import type { FeatureField } from '~~/shared/config/tiers'
import { useLogger } from '../platform/logger'

const log = useLogger('api')

// The handler contract (docs/contributing/api-handlers.md). Every route
// declares its access policy, its inputs as zod schemas and its unconditional
// gates; the wrapper runs them in a fixed order and hands the handler a typed
// context. Response types are still inferred by Nitro from the return value.
//
// Order, per request:
//   1. instance gate (billing / legal surfaces); rate limits with `phase: 'before-access'`
//   2. policy gate: session / service credentials (test-only 404 here); `recentLogin`
//   3. params, query: safeParse → 400
//   4. body: safeParse → 400
//   5. policy resolve: object-level access → 404 / 403
//   6. plan feature
//   7. the other rate limits
//   8. idempotency
//   9. the handler
// A policy with an error format (`allow.scim()`) answers every refusal of
// these steps in its protocol's body instead of the API envelope.
//
// h3's readValidatedBody / getValidatedQuery are not used: they rethrow any
// error from the validator as a 400 whose data is the raw zod error.

/**
 * A body the handler reads when it needs it, through `ctx.parseBody()`:
 * unreadable JSON or a body that fails the schema is `null`, never a 400.
 * For routes whose every request must look the same (a public lookup that
 * answers one uniform 404) or that must do something first (the SAML ACS
 * consumes its single-use flow cookie before it looks at the post).
 */
export interface LenientBody<S extends ZodType = ZodType> {
  readonly lenient: S
}

export function lenientBody<S extends ZodType>(schema: S): LenientBody<S> {
  return { lenient: schema }
}

export type BodySpec = ZodType | LenientBody | 'none' | 'raw' | 'custom'

interface RateLimitBase {
  namespace: string
  max: number
  windowMs: number
  /** Code of the 429; default `rate/limited`. */
  error?: ApiErrorCode
}

export type RateLimitSpec<Ctx> = RateLimitBase & ({
  /**
   * `user`: the signed-in user's id; `ip`: the client key (IPv4 or IPv6 /64);
   * `user+ip`: `<userId>:<client key>` (neither a stolen session nor a shared
   * address alone exhausts it); a function gets the context and the event.
   */
  key: 'user' | 'ip' | 'user+ip' | ((ctx: Ctx, event: H3Event) => string)
  phase?: 'after-access'
} | {
  key: 'ip'
  /**
   * Count every request before the session and the object lookup, so probing
   * ids that don't exist (404) is throttled too. Only for the client key: no
   * user or object is known yet.
   */
  phase: 'before-access'
})

type Out<S> = S extends ZodType ? z.output<S> : undefined
type In<S> = S extends ZodType ? z.input<S> : S extends LenientBody<infer L> ? z.input<L> : undefined

export type ParsedInput<P, Q, B> = {
  params: Out<P>
  query: Out<Q>
  body: Out<B>
} & (B extends 'raw' ? { rawBody: () => Promise<Buffer | undefined> } : unknown)
& (B extends LenientBody<infer L> ? { parseBody: () => Promise<z.output<L> | null> } : unknown)

export interface ApiHandlerDef<Ctx, P, Q, B extends BodySpec, R> {
  access: Policy<Ctx>
  params?: P
  query?: Q
  /** A zod schema, `lenientBody(schema)` (`ctx.parseBody()`, null instead of a 400), `'none'` (default), `'raw'` (`ctx.rawBody()`), or `'custom'` (the handler reads it: multipart, size-limited readers). */
  body?: B
  /** Code for validation failures (keeps a route's existing code, e.g. `share/invalid`); default `request/invalid`. Its params must accept `field` and `fields`. */
  invalidCode?: ApiErrorCode
  /** A feature the instance may not run: 404 (`billing/disabled`, `legal/disabled`, `custom-domain/disabled`) before anything else. */
  instance?: 'billing' | 'legalSurfaces' | 'customDomains'
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

type InputPart = 'params' | 'query' | 'body'
type Refuse = (part: InputPart, fields: FieldIssue[]) => Error

function parseWith<S extends ZodType>(schema: S, value: unknown, part: InputPart, refuse: Refuse): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw refuse(part, fieldIssues(result.error))
  return result.data
}

/**
 * The response of a policy's error format. Fails closed: a formatter that
 * throws, or picks a status that is not an error, can't turn a refusal into
 * a success; the original error then takes the normal (sanitised) path, or
 * the formatted body leaves as a 500.
 */
function formatError(format: ErrorFormat, error: unknown, event: H3Event): unknown {
  let out: ReturnType<ErrorFormat['respond']>
  try {
    out = format.respond(error)
  } catch {
    throw error
  }
  const status = Number.isInteger(out.status) && out.status >= 400 && out.status <= 599 ? out.status : 500
  setHeader(event, 'content-type', out.contentType)
  setResponseStatus(event, status)
  return out.body
}

const isSchema = (b: unknown): b is ZodType => typeof b === 'object' && b !== null && typeof (b as ZodType).safeParse === 'function'
const isLenient = (b: unknown): b is LenientBody => typeof b === 'object' && b !== null && isSchema((b as LenientBody).lenient)

async function parseLenient(event: H3Event, spec: LenientBody): Promise<unknown> {
  let raw: unknown
  try {
    raw = await readBody(event)
  } catch {
    return null
  }
  const result = spec.lenient.safeParse(raw)
  return result.success ? result.data : null
}

function rateKey<Ctx>(spec: RateLimitSpec<Ctx>, ctx: Ctx, event: H3Event): string {
  if (typeof spec.key === 'function') return spec.key(ctx, event)
  if (spec.key === 'ip') return getClientRateLimitKey(event)
  const user = (ctx as { user?: { id: number } | null }).user
  // A per-user limit on a route that admitted no user is a wiring bug: refuse.
  if (!user) throw new Error(`rate limit ${spec.namespace}: key '${spec.key}' on a route without a user`)
  if (spec.key === 'user') return String(user.id)
  if (spec.key === 'user+ip') return `${user.id}:${getClientRateLimitKey(event)}`
  throw new Error(`rate limit ${spec.namespace}: unknown key ${String(spec.key)}`)
}

async function enforce<Ctx>(spec: RateLimitSpec<Ctx>, key: string): Promise<void> {
  if (!(await checkRateLimit(spec.namespace, key, spec.max, spec.windowMs))) {
    throw (apiError as (c: ApiErrorCode) => Error)(spec.error ?? 'rate/limited')
  }
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
  const errorFormat = isPolicy(def.access) ? def.access.errorFormat : undefined
  const refuse: Refuse = errorFormat ? (part, fields) => errorFormat.invalid(part, fields) : (_part, fields) => invalid(invalidCode, fields)
  const limits: readonly RateLimitSpec<Ctx>[] = def.rateLimit === undefined ? [] : Array.isArray(def.rateLimit) ? def.rateLimit : [def.rateLimit as RateLimitSpec<Ctx>]
  for (const spec of limits) {
    // Before access nothing but the client address is known; any other key is a wiring bug.
    // (The type already forbids it; this holds for untyped callers.)
    const { phase, key, namespace } = spec as { phase?: string, key: unknown, namespace: string }
    if (phase === 'before-access' && key !== 'ip') throw new Error(`rate limit ${namespace}: phase 'before-access' needs key 'ip'`)
  }
  const early = limits.filter(spec => spec.phase === 'before-access')
  const late = limits.filter(spec => spec.phase !== 'before-access')

  const run = async (event: H3Event, access: Policy<Ctx>): Promise<R> => {
    if (def.instance === 'billing') assertBillingEnabled()
    else if (def.instance === 'legalSurfaces') assertLegalSurfacesEnabled()
    else if (def.instance === 'customDomains' && !customDomainSettings()) throw apiError('custom-domain/disabled')
    for (const spec of early) await enforce(spec, getClientRateLimitKey(event))

    const gate = await access.gate(event)
    if (def.recentLogin) await requireRecentLogin(event)

    const rawParams = getRouterParams(event)
    const params = def.params ? parseWith(def.params, rawParams, 'params', refuse) : undefined
    const query = def.query ? parseWith(def.query, getQuery(event), 'query', refuse) : undefined
    let body: unknown
    if (isSchema(def.body)) {
      let raw: unknown
      try {
        raw = await readBody(event)
      } catch {
        throw refuse('body', [{ path: '', issue: 'invalid_format', format: 'json' }])
      }
      body = parseWith(def.body, raw, 'body', refuse)
    }

    const input: ResolveInput = {
      params: (params as Record<string, unknown> | undefined) ?? rawParams,
      query: query as Record<string, unknown> | undefined,
      body
    }
    const ctx = await access.resolve(event, gate, input)
    if (ctx === null || typeof ctx !== 'object') throw createError({ statusCode: 500, message: 'Access policy returned no context' })

    if (def.plan) assertPlanFeature(await planFor(ctx as never), def.plan.feature, def.plan.message)
    for (const spec of late) await enforce(spec, rateKey(spec, ctx, event))

    const full = {
      ...ctx,
      params,
      query,
      body,
      event,
      ...(def.body === 'raw' ? { rawBody: () => readRawBody(event, false) } : {}),
      ...(isLenient(def.body) ? { parseBody: () => parseLenient(event, def.body as LenientBody) } : {})
    } as unknown as Ctx & ParsedInput<P, Q, B> & { event: H3Event }
    const call = async () => def.handler(full)
    if (def.idempotency) {
      const user = (ctx as { user?: { id: number } | null }).user
      if (!user) throw new Error('idempotency needs a signed-in user')
      return withIdempotency(event, def.idempotency.scope, user.id, call)
    }
    return call()
  }

  const handler = defineEventHandler(async (event): Promise<R> => {
    const access: unknown = def.access
    // Fail closed: a route whose policy isn't one of ours never runs.
    if (!isPolicy(access)) {
      log.error('access is not an allow.* policy', { path: event.path })
      throw createError({ statusCode: 500, message: 'Route has no valid access policy' })
    }
    if (!errorFormat) return run(event, access as Policy<Ctx>)
    try {
      return await run(event, access as Policy<Ctx>)
    } catch (error) {
      return formatError(errorFormat, error, event) as R
    }
  })

  const descriptor: PolicyDescriptor = isPolicy(def.access)
    ? { kind: def.access.kind, sessionless: def.access.sessionless, reason: def.access.reason, need: def.access.need }
    : BROKEN_POLICY
  return Object.assign(handler, { '~access': descriptor }) as unknown as ApiEventHandler<R, { params: In<P>, query: In<Q>, body: In<B> }>
}
