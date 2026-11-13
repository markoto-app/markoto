import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { useDatabase } from './client'

/**
 * Apply the pending migrations of `migrationsFolder` (drizzle-kit's
 * migrator: applied files are tracked in `__drizzle_migrations`, all pending
 * ones run in ONE transaction).
 */
export async function applyMigrations(migrationsFolder: string): Promise<void> {
  await migrate(useDatabase(), { migrationsFolder })
}
