import { closeDatabase } from '../db/client'
import { closeLitellmPool } from '../db/litellm'
import { applyMigrations } from '../db/migrate'

// The database lifecycle as the plugins see it: migrate at boot, close the
// pools at shutdown. Plugins never touch a pool or drizzle themselves.

export { applyMigrations }

/** Close the app pool and the LiteLLM spend pool (Nitro `close`). */
export async function closeDatabaseConnections(): Promise<void> {
  await Promise.all([closeDatabase(), closeLitellmPool()])
}
