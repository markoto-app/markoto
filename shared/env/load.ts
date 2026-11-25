// Turns a raw environment into the typed object of one process.
//
//   loadEnv('app')  : boot: every problem at once, or throws EnvError.
//   useEnv()       : runtime accessor of the app: same parsing, but a
//                      missing required value is '' instead of an error
//                      (boot already enforced it; scripts and unit tests
//                      run without the full set).
//
// Neither ever prints a value: messages name the variable and what was
// expected. Test mode (TEST_MODE=1 on a non-deployment) relaxes required
// values and presence rules, never types.

import { EnvValueError } from './coerce'
import { nameFor, VALIDATED_SERVICES, type AnyVar, type RawEnv, type RuleContext, type ValidatedService } from './define'
import { NAMESPACES, RULES, type AppEnv, type ServiceEnv } from './registry'
import { isTestModeEnabled } from '../utils/security/testMode'
import { isProduction } from './runtime'

export class EnvError extends Error {
  constructor(readonly service: ValidatedService, readonly problems: readonly string[]) {
    super(formatEnvProblems(service, problems))
    this.name = 'EnvError'
  }
}

/** Operator-facing report: one line per problem. */
function formatEnvProblems(service: ValidatedService, problems: readonly string[]): string {
  const count = problems.length === 1 ? '1 problem' : `${problems.length} problems`
  return `Invalid configuration of the ${SERVICE_LABEL[service]} (${count}):\n`
    + problems.map(p => `  - ${p}`).join('\n')
    + '\nEvery variable is described in docs/reference/configuration.md.'
}

const SERVICE_LABEL: Record<ValidatedService, string> = {
  app: 'app (Nuxt)',
  sync: 'sync server',
  renderer: 'renderer'
}

export interface LoadOptions {
  /** Treat missing required values as '' (runtime reads; boot already checked them). */
  relaxRequired?: boolean
  /**
   * Checks that need code outside shared/ (the app passes its server-side
   * ones), run on the parsed env; their messages join the same report.
   */
  extraChecks?: (env: never, ctx: RuleContext) => string[]
  /** Receives rule warnings (default: console.warn). */
  onWarning?: (message: string) => void
  /** Run the cross-field rules (default true; runtime reads only parse). */
  rules?: boolean
}

type Mutable = Record<string, Record<string, unknown>>

interface Problems {
  /** Values that do not parse, the rules wait until these are fixed. */
  type: string[]
  missing: string[]
}

/** Parse one variable as `service` reads it. */
function parseVar(spec: AnyVar, service: ValidatedService, source: RawEnv, required: boolean, problems: Problems): unknown {
  const name = nameFor(spec, service)
  const raw = source[name]
  const trimmed = typeof raw === 'string' ? raw.trim() : undefined
  if (trimmed === '' && spec.emptyIsValue && raw !== undefined) return ''
  if (trimmed === undefined || trimmed === '') return unsetValue(spec, name, source, required, problems)
  try {
    return spec.type.parse(trimmed)
  } catch (e) {
    if (e instanceof EnvValueError) {
      problems.type.push(`${name}: ${e.message}`)
      return spec.default
    }
    throw e
  }
}

/** The value of an unset variable: its default, else '' for an always-required one (reported when `required`). */
function unsetValue(spec: AnyVar, name: string, source: RawEnv, required: boolean, problems: Problems): unknown {
  if (spec.default !== undefined) return spec.default
  const requiredHere = spec.required === 'always' || (spec.required === 'production' && source.NODE_ENV === 'production')
  if (!requiredHere) return undefined
  if (required) problems.missing.push(`${name}: required, not set`)
  return spec.required === 'always' ? '' : undefined
}

function build(service: ValidatedService, source: RawEnv, enforceRequired: boolean, problems: Problems): Mutable {
  const out: Mutable = {}
  for (const [nsName, ns] of Object.entries(NAMESPACES)) {
    for (const [key, spec] of Object.entries(ns.vars as Record<string, AnyVar>)) {
      if (!spec.services.includes(service)) continue
      const group = (out[nsName] ??= {})
      group[key] = parseVar(spec, service, source, enforceRequired, problems)
    }
  }
  return out
}

function deepFreeze<T>(obj: T): T {
  for (const value of Object.values(obj as object)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value)
  }
  return Object.freeze(obj)
}

/**
 * Validate and return the typed environment of `service`. Reports every
 * problem at once (EnvError); never prints a value.
 */
export function loadEnv<S extends ValidatedService>(
  service: S,
  source: RawEnv = process.env,
  options: LoadOptions = {}
): ServiceEnv<S> {
  if (!VALIDATED_SERVICES.includes(service)) throw new Error(`loadEnv: unknown service ${service}`)
  const testMode = isTestModeEnabled(source)
  const ctx: RuleContext = { service, production: source.NODE_ENV === 'production', testMode, raw: source }
  const relaxed = options.relaxRequired === true || testMode
  const found: Problems = { type: [], missing: [] }
  const env = build(service, source, !relaxed, found)
  const problems = [...found.missing, ...found.type]

  // Cross-field rules need correctly typed values (a missing required
  // one reads as ''); with type errors they could misfire, so they wait.
  if (found.type.length === 0 && options.rules !== false) {
    problems.push(...ruleProblems(env, ctx, relaxed, options))
  }

  if (problems.length > 0) throw new EnvError(service, problems)
  // `build` fills exactly the variables the registry assigns to `service`, which is what ServiceEnv<S> projects.
  return deepFreeze(env) as unknown as ServiceEnv<S>
}

/** The cross-field rules of `ctx.service` (warnings go to `onWarning`), then the caller's extra checks. */
function ruleProblems(env: Mutable, ctx: RuleContext, relaxed: boolean, options: LoadOptions): string[] {
  const problems: string[] = []
  const warn = options.onWarning ?? ((m: string) => console.warn(`[env] ${m}`))
  for (const rule of RULES) {
    if (!rule.services.includes(ctx.service)) continue
    if (rule.relaxedInTestMode && relaxed) continue
    // A rule only reads the namespaces of the services it lists (`rule.services`).
    const messages = rule.check(env as unknown as AppEnv, ctx)
    if (rule.warning) messages.forEach(warn)
    else problems.push(...messages)
  }
  if (options.extraChecks) problems.push(...options.extraChecks(env as never, ctx))
  return problems
}

const RUNTIME_READ: LoadOptions = { relaxRequired: true, rules: false }

// Runtime reads parse process.env once per process. Under Vitest they
// parse it on every call instead, so a test provides configuration the
// way an operator does, `vi.stubEnv('NUXT_X', …)`, restored after each
// test (`unstubEnvs` in vitest.config.ts; docs/contributing/testing.md),
// without a reset hook in production code.
const cache = new Map<ValidatedService, unknown>()

/**
 * The typed environment of `service` for runtime reads: same parsing as
 * boot, but a missing required value is '' (boot already enforced it;
 * scripts and unit tests run without the full set) and the cross-field
 * rules are not re-run. Throws EnvError on a value that does not parse.
 */
export function runtimeEnv<S extends ValidatedService>(service: S): ServiceEnv<S> {
  if (process.env.VITEST) return loadEnv(service, process.env, RUNTIME_READ)
  let env = cache.get(service) as ServiceEnv<S> | undefined
  if (!env) {
    try {
      env = loadEnv(service, process.env, RUNTIME_READ)
    } catch (e) {
      if (!(e instanceof EnvError)) throw e
      failEarlyRead(service, e)
    }
    cache.set(service, env)
  }
  return env
}

/**
 * A read before boot validation (a module imported early) found a bad
 * value: report everything boot would, not just the type problems, and
 * stop a production process the same way boot validation does.
 */
function failEarlyRead(service: ValidatedService, e: EnvError): never {
  let report: EnvError = e
  try {
    loadEnv(service, process.env, { onWarning: () => {} })
  } catch (full) {
    if (full instanceof EnvError) report = full
  }
  if (isProduction()) {
    console.error(report.message)
    process.exit(1)
  }
  throw report
}

/** Use the env validated at boot for the runtime reads that follow. */
export function primeEnv<S extends ValidatedService>(service: S, env: ServiceEnv<S>): void {
  cache.set(service, env)
}

/**
 * The app's typed environment (see `runtimeEnv`). With a `source` it
 * parses that record instead (pure helpers that take an env-shaped record).
 */
export function useEnv(source?: RawEnv): AppEnv {
  if (source !== undefined && source !== process.env) return loadEnv('app', source, RUNTIME_READ)
  return runtimeEnv('app')
}
