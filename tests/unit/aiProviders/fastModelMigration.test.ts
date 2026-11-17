import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getTableColumns } from 'drizzle-orm'
import { userAiProviders } from '../../../server/db/schema'

// The chat provider's optional "Fast model" (the worker model on a user's
// own key) is a nullable column with a migration that adds it, so a
// database created before it gains the column at boot.

const DRIZZLE = new URL('../../../drizzle/', import.meta.url)

const journal = z.object({ entries: z.array(z.object({ tag: z.string() })) })
  .parse(JSON.parse(readFileSync(fileURLToPath(new URL('meta/_journal.json', DRIZZLE)), 'utf8')))

describe('user_ai_providers.fast_model', () => {
  it('is a nullable text column in the schema', () => {
    const column = getTableColumns(userAiProviders).fastModel
    expect(column.name).toBe('fast_model')
    expect(column.notNull).toBe(false)
    expect(column.columnType).toBe('PgText')
  })

  it('a journalled migration adds it', () => {
    const adding = journal.entries.filter(({ tag }) =>
      /ALTER TABLE "user_ai_providers" ADD COLUMN "fast_model" text;/.test(readFileSync(fileURLToPath(new URL(`${tag}.sql`, DRIZZLE)), 'utf8')))
    expect(adding.map(e => e.tag)).toEqual(['0007_wonderful_wong'])
  })
})
