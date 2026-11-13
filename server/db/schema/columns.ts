// Column types drizzle doesn't ship.

import { customType } from 'drizzle-orm/pg-core'

// drizzle has no native `tsvector`; generated columns are STORED so the
// GIN index stays in sync without triggers.
export const tsvector = customType<{ data: string }>({
  dataType() { return 'tsvector' }
})

// Raw bytes (Y.js updates). Read and written with plain SQL through
// `server/utils/documents/yjsLog.ts`, never through drizzle's query builder.
export const bytea = customType<{ data: Buffer }>({
  dataType() { return 'bytea' }
})
