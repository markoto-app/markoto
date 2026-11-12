import { openSecret, sealSecret, secretContext } from '../platform/secretBox'
import type { AiProviderRow } from '../../repos/aiProviders'
import type { AiCapability } from '~~/shared/ai/providers'

// Users' own provider API keys at rest: one HKDF purpose, bound to the row
// (user + capability) so a key copied into another user's row won't decrypt.

/** Encrypt a provider key for its row. */
export function sealProviderKey(userId: number, capability: AiCapability, apiKey: string): string {
  return sealSecret('ai-provider-key', secretContext.aiProviderKey(userId, capability), apiKey)
}

/** Decrypt a stored provider key; throws SecretUnreadableError when it can't. */
export function openProviderKey(row: Pick<AiProviderRow, 'userId' | 'capability' | 'apiKeyEncrypted'>): string {
  return openSecret('ai-provider-key', secretContext.aiProviderKey(row.userId, row.capability), row.apiKeyEncrypted)
}
