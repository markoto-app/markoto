// The one way code outside the repos runs several repo writes atomically:
// `withTransaction(async (tx) => { await repoA(..., tx); await repoB(..., tx) })`.
// The handle is opaque (server/db/client.ts): it can only be passed on to
// repo functions, never used to build a query.

export { withTransaction, type TxHandle } from '../db/client'
