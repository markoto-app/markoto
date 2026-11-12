// Building blocks of the environment registry. Each variable is declared
// once with `v()` inside a namespace (`defineNamespace`); everything else —
// the typed object `loadEnv` returns, boot validation, .env.example, the
// configuration reference and the compose/deploy drift tests — is derived
// from these declarations.

import type { Coercer } from './coerce'

/**
 * Who reads a variable. The three Bun processes validate their own set at
 * boot; the others are listed so the generated reference and the drift
 * tests know where a value has to go.
 */
export type Service
  = | 'app' // Nuxt/Nitro server
    | 'sync' // Hocuspocus sync server (sync-server/)
    | 'renderer' // Playwright PDF/PNG sidecar (renderer/)
    | 'litellm' // LiteLLM proxy (deploy/config/litellm/)
    | 'markitdown' // import converter (markitdown-server/)
    | 'backup' // backup sidecar (backup-server/)
    | 'compose' // interpolated by the compose files / install.sh only
    | 'build' // read by `nuxt build`, not at runtime

export const VALIDATED_SERVICES = ['app', 'sync', 'renderer'] as const
export type ValidatedService = typeof VALIDATED_SERVICES[number]

/** Which deployment shapes use a variable. */
export type Scope = 'both' | 'self-host' | 'hosted' | 'dev' | 'test'

/**
 * When a variable must be set. `always` and `production` (NODE_ENV) are
 * enforced by the loader; `{ when }` documents a condition that a
 * namespace rule enforces (the rule names the variable in its message).
 */
export type Required = 'always' | 'production' | { when: string }

/** Raw environment as handed to a process. */
export type RawEnv = Record<string, string | undefined>

export interface VarSpec<T, S extends readonly Service[] = readonly Service[]> {
  /** Canonical name (what the app container and the operator's .env use). */
  name: string
  type: Coercer<T>
  /** One line for .env.example and the reference: what it does. */
  doc: string
  services: S
  scope: Scope
  default?: T
  /** Shown in the reference instead of the literal default (e.g. a computed one). */
  defaultDoc?: string
  required?: Required
  /** Never printed; empty in .env.example. */
  secret?: boolean
  /**
   * The same value under another name in another container, e.g. the
   * sync server reads the app's `NUXT_JWT_SECRET` as `JWT_SECRET`.
   */
  aliases?: Partial<Record<Service, string>>
  /**
   * An explicitly empty value is a value, distinct from unset (e.g.
   * `NUXT_DOCS_CANONICAL_BASE=` = canonical to self). Default: empty = unset.
   */
  emptyIsValue?: boolean
  /** Value written uncommented into .env.example (dev-stack value). */
  example?: string
  /**
   * The compose files do not pass it to the services above (read from an
   * image default, only set in dev, …). The reason is printed in the reference.
   */
  notPassed?: string
  /**
   * Set by the compose files for a container (its port, the app's internal
   * URL), not an operator setting: left out of .env.example.
   */
  internal?: boolean
  /** Older name still accepted by the compose files. */
  deprecatedNames?: readonly string[]
}

export interface VarDef<T, Opt extends boolean, S extends readonly Service[] = readonly Service[]> extends VarSpec<T, S> {
  /** Type-level marker: does the typed value include `undefined`? */
  readonly __optional?: Opt
}

/** A variable with a default or `required: 'always'` is never undefined in the typed object. */
export function v<T, const S extends readonly Service[]>(spec: VarSpec<T, S> & { default: T }): VarDef<T, false, S> & { default: T }
export function v<T, const S extends readonly Service[]>(spec: VarSpec<T, S> & { required: 'always' }): VarDef<T, false, S>
export function v<T, const S extends readonly Service[]>(spec: VarSpec<T, S>): VarDef<T, true, S>
export function v<T, const S extends readonly Service[]>(spec: VarSpec<T, S>): VarDef<T, boolean, S> {
  return spec
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the registry is heterogeneous by design
export type AnyVar = VarDef<any, boolean, readonly Service[]>

export interface RuleContext {
  service: ValidatedService
  /** NODE_ENV=production. */
  production: boolean
  /** TEST_MODE=1 on a non-deployment (shared/utils/security/testMode.ts). */
  testMode: boolean
  /** The raw environment, for the few checks that need a value before parsing. */
  raw: RawEnv
}

export interface Rule<Env> {
  /** Processes the rule applies to. */
  services: readonly ValidatedService[]
  /** Skipped under test mode (presence-style rules; type rules always run). */
  relaxedInTestMode?: boolean
  /** Reported as a boot warning instead of failing boot. */
  warning?: boolean
  /** Variable names the rule talks about (for the reference). */
  vars: readonly string[]
  /** Short description for the reference. */
  doc: string
  /** Returns one message per problem; each names the real variable(s). */
  check(env: Env, ctx: RuleContext): string[]
}

export interface Namespace<Vars extends Record<string, AnyVar>> {
  name: string
  /** Heading + intro for .env.example and the reference. */
  title: string
  intro: string
  vars: Vars
}

export function defineNamespace<const Vars extends Record<string, AnyVar>>(ns: Namespace<Vars>): Namespace<Vars> {
  return ns
}

/** Name under which `service` reads a variable. */
export function nameFor(spec: AnyVar, service: Service): string {
  return spec.aliases?.[service] ?? spec.name
}

/** Typed value of one variable. */
export type VarValue<D> = D extends VarDef<infer T, infer Opt, readonly Service[]> ? (Opt extends false ? T : T | undefined) : never

/** Services a variable declaration lists. */
type ServicesOf<D> = D extends { services: readonly (infer X)[] } ? X : never

/** Typed values of a namespace, restricted to the variables `S` reads. */
export type NamespaceValues<Vars, S extends Service> = {
  readonly [K in keyof Vars as S extends ServicesOf<Vars[K]> ? K : never]: VarValue<Vars[K]>
}
