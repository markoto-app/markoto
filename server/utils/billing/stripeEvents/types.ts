import type Stripe from 'stripe'
import type { TxHandle } from '../../../repos/transaction'

// The dispatcher wraps the whole event in one transaction (`withTransaction`)
// so the dedup INSERT and the billing UPDATEs commit together; handlers pass
// its opaque handle on to the repo functions.
export type { TxHandle }

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
  db?: TxHandle
  deferAfterCommit?: DeferredAfterCommit
}
