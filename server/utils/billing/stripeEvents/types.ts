import type Stripe from 'stripe'
import type { useDatabase } from '../../platform/database'

// Drizzle's node-postgres transaction handle — same shape as the
// top-level `db` for our usage but typed distinctly. We accept either
// for handler reuse: the dispatcher wraps the whole event in a single
// transaction so the dedup INSERT and the user UPDATE commit together.
//
// `DbOrTx` is whatever drizzle accepts for chained query builders: the
// pool-backed result of `useDatabase()` OR a `tx` argument inside
// `db.transaction(async tx => ...)`. They share the chained-builder
// surface we need; we don't actually narrow further.
export type DbOrTx = ReturnType<typeof useDatabase> | Parameters<Parameters<ReturnType<typeof useDatabase>['transaction']>[0]>[0]

// Handlers queue side-effects that must run AFTER the
// surrounding transaction commits — primarily LiteLLM virtual-key
// budget syncs. Calling `updateUserKeyBudget` inline acquires its own
// pool connection while the surrounding TX still holds an exclusive
// lock on the same `users` row, deadlocking until `statement_timeout`
// fires. The dispatcher walks this queue after the TX commits and
// runs each closure best-effort.
export type DeferredAfterCommit = (() => Promise<void>)[]

/** What every event handler runs with: the SDK client, the event's transaction, the after-commit queue. */
export interface StripeHandlerOptions {
  stripe: Stripe
  db: DbOrTx
  deferAfterCommit?: DeferredAfterCommit
}
