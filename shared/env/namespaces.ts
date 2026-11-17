// The variable namespaces and the typed environment they produce. Kept
// apart from registry.ts (which adds the cross-field rules) so the rules
// can import these types without an import cycle.

import type { NamespaceValues, Service, ValidatedService } from './define'
import { core, server, test } from './vars/core'
import { auth, oauth } from './vars/auth'
import { database, markitdown, renderer, storage, valkey } from './vars/data'
import { observability, sync } from './vars/sync'
import { ai, litellm, providers } from './vars/ai'
import { billing, tiers } from './vars/billing'
import { brand, email, legal } from './vars/legal'
import { backup, deploy, publish } from './vars/publish'
import { analytics } from './vars/analytics'

export const NAMESPACES = {
  core,
  server,
  auth,
  oauth,
  database,
  valkey,
  storage,
  markitdown,
  sync,
  renderer,
  litellm,
  providers,
  ai,
  billing,
  tiers,
  legal,
  email,
  brand,
  publish,
  analytics,
  observability,
  test,
  deploy,
  backup
} as const

export type Registry = typeof NAMESPACES

type NsValues<N extends keyof Registry, S extends Service> = NamespaceValues<Registry[N]['vars'], S>

/** The typed, validated environment of one process, grouped by namespace. */
export type ServiceEnv<S extends ValidatedService> = {
  readonly [N in keyof Registry as keyof NsValues<N, S> extends never ? never : N]: NsValues<N, S>
}

export type AppEnv = ServiceEnv<'app'>
export type SyncEnv = ServiceEnv<'sync'>
export type RendererEnv = ServiceEnv<'renderer'>
