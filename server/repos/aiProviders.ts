import { and, eq } from 'drizzle-orm'
import { userAiProviders } from '../db/schema'
import { useDatabase } from '../db/client'
import type { AiCapability } from '~~/shared/ai/providers'
import type { UserScope } from './proofs'

// `user_ai_providers` repository: bring-your-own-key provider configs.
//
// This layer stores and returns the ENCRYPTED key only. Encryption,
// decryption and the "never hand the key to the client" rule live in
// `server/utils/aiProviders/store.ts`; nothing here ever sees plaintext.
// Account deletion: FK `ON DELETE CASCADE` on `user_id`.

export type AiProviderRow = typeof userAiProviders.$inferSelect

export interface AiProviderUpsert {
  capability: AiCapability
  baseUrl: string
  model: string
  /** Chat only: the worker model on the same endpoint; null = the chat model. */
  fastModel?: string | null
  apiKeyEncrypted: string
  apiKeyLast4: string
  supportsVision: boolean
  supportsTools: boolean | null
  lastVerifiedAt: Date | null
}

/** Every config of the user (encrypted keys included): their own AI calls, the settings page, the data export. */
export async function listAiProviders(user: UserScope): Promise<AiProviderRow[]> {
  const db = useDatabase()
  return await db.select().from(userAiProviders).where(eq(userAiProviders.userId, user.userId))
}

export async function getAiProvider(user: UserScope, capability: AiCapability): Promise<AiProviderRow | null> {
  const db = useDatabase()
  const rows = await db.select().from(userAiProviders)
    .where(and(eq(userAiProviders.userId, user.userId), eq(userAiProviders.capability, capability)))
    .limit(1)
  return rows[0] ?? null
}

/** Insert or replace the user's config for one capability. */
export async function upsertAiProvider(self: UserScope, input: AiProviderUpsert): Promise<AiProviderRow> {
  const db = useDatabase()
  const now = new Date()
  const values = {
    baseUrl: input.baseUrl,
    model: input.model,
    fastModel: input.capability === 'chat' ? (input.fastModel ?? null) : null,
    apiKeyEncrypted: input.apiKeyEncrypted,
    apiKeyLast4: input.apiKeyLast4,
    supportsVision: input.supportsVision,
    supportsTools: input.supportsTools,
    lastVerifiedAt: input.lastVerifiedAt,
    updatedAt: now
  }
  const rows = await db.insert(userAiProviders)
    .values({ userId: self.userId, capability: input.capability, ...values })
    .onConflictDoUpdate({ target: [userAiProviders.userId, userAiProviders.capability], set: values })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('[aiProviders] upsert returned no row')
  return row
}

/** Record a verification result on an existing row. No-op when the row is gone. */
export async function markAiProviderVerified(
  self: UserScope,
  capability: AiCapability,
  result: { supportsTools: boolean | null, verifiedAt: Date }
): Promise<void> {
  const userId = self.userId
  const db = useDatabase()
  await db.update(userAiProviders)
    .set({ supportsTools: result.supportsTools, lastVerifiedAt: result.verifiedAt })
    .where(and(eq(userAiProviders.userId, userId), eq(userAiProviders.capability, capability)))
}

/** Account deletion: remove every config (and encrypted key) of the user. Returns the count. */
export async function deleteAllAiProvidersForUser(user: UserScope): Promise<number> {
  const userId = user.userId
  const db = useDatabase()
  const rows = await db.delete(userAiProviders)
    .where(eq(userAiProviders.userId, userId))
    .returning({ id: userAiProviders.id })
  return rows.length
}

/** Returns true when a row was deleted. */
export async function deleteAiProvider(self: UserScope, capability: AiCapability): Promise<boolean> {
  const userId = self.userId
  const db = useDatabase()
  const rows = await db.delete(userAiProviders)
    .where(and(eq(userAiProviders.userId, userId), eq(userAiProviders.capability, capability)))
    .returning({ id: userAiProviders.id })
  return rows.length > 0
}
