// Ids of `serial` columns (users, activity rows, identities, audit rows) read
// from a path or query. Postgres `integer` stops at 2^31 - 1: a larger
// number would fail the query (500) instead of naming no row.
import { z } from 'zod'

export const PG_INTEGER_MAX = 2_147_483_647

/** A positive `serial` id; anything else is a 400 (or the route's own refusal). */
export const serialId = z.coerce.number().int().positive().max(PG_INTEGER_MAX)
