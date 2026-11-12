// The environment registry: every variable markoto reads or passes, in
// one place. Add a variable to the namespace file it belongs to (vars/*),
// then run `bun scripts/env-gen.ts` (docs/contributing/configuration.md).

import type { AnyVar, Rule } from './define'
import { NAMESPACES, type AppEnv, type Registry } from './namespaces'
import { coreRules } from './rules/core'
import { authRules } from './rules/auth'
import { aiRules } from './rules/ai'
import { billingRules } from './rules/billing'
import { legalRules } from './rules/legal'

export { NAMESPACES }
export type { AppEnv, Registry, ServiceEnv, SyncEnv } from './namespaces'

/** Cross-field rules; each names the variables it checks. */
export const RULES: readonly Rule<AppEnv>[] = [
  ...coreRules,
  ...authRules,
  ...aiRules,
  ...billingRules,
  ...legalRules
]

export interface RegisteredVar {
  namespace: keyof Registry
  key: string
  spec: AnyVar
}

/** Every declared variable, in declaration order. */
export function registeredVars(): RegisteredVar[] {
  const out: RegisteredVar[] = []
  for (const [namespace, ns] of Object.entries(NAMESPACES)) {
    for (const [key, spec] of Object.entries(ns.vars as Record<string, AnyVar>)) {
      out.push({ namespace: namespace as keyof Registry, key, spec })
    }
  }
  return out
}
