// Per-request AI provider resolution for bring-your-own-key.
//
// Resolution order per capability:
//   1. the user's own config (`user_ai_providers`)
//   2. the instance default (`NUXT_AI_DEFAULT_*` env, see config.ts)
//   3. unavailable (null)
//
// The result tells the call site exactly what to put in the LiteLLM
// request body (see `requestFields.ts`):
//   - user config / instance default WITH base URL → model `byok/<id>`
//     plus `api_key` + `api_base` clientside credentials. The `byok/*`
//     deployment in infra/litellm/config.yaml has zero cost, so these
//     calls never debit the user's LiteLLM `max_budget`.
//   - instance default WITHOUT base URL → the model alias as-is
//     (platform-paid, debits the budget like before BYOK).
//
// The request still authenticates with the user's LiteLLM virtual key,
// so per-key rpm limits and spend-log tags keep working for BYOK.

import { decryptToken } from '../litellm/tokenCrypto'
import { listAiProviders, type AiProviderRow } from '../../repos/aiProviders'
import { readInstanceDefault, realtimeDictationModel } from './config'
import {
  MISTRAL_API_HOST,
  baseUrlHost,
  type AiAvailability,
  type AiCapability,
  type AiCapabilityStatus
} from '~~/shared/ai/providers'

/** LiteLLM deployment prefix for clientside-credential (BYOK) calls. */
export const BYOK_MODEL_PREFIX = 'byok/'

export interface ResolvedAiProvider {
  capability: AiCapability
  source: 'user' | 'instance'
  /** Upstream model id as configured (display + `byok/<model>`). */
  model: string
  /** Clientside credentials; null = LiteLLM model alias (platform-paid). */
  credentials: { baseUrl: string, apiKey: string } | null
  supportsVision: boolean
}

export type ResolvedAiProviders = Record<AiCapability, ResolvedAiProvider | null>

/** Calls through this provider debit the user's platform AI budget. */
export function isPlatformBilled(provider: ResolvedAiProvider | null): boolean {
  return provider !== null && provider.credentials === null
}

/** The model name to send to LiteLLM. */
export function litellmModelFor(provider: ResolvedAiProvider): string {
  return provider.credentials ? `${BYOK_MODEL_PREFIX}${provider.model}` : provider.model
}

function fromUserRow(row: AiProviderRow): ResolvedAiProvider | null {
  let apiKey: string
  try {
    apiKey = decryptToken(row.apiKeyEncrypted)
  } catch {
    // Undecryptable (salt rotated without re-encrypting). Treat as
    // unconfigured rather than failing every AI call; the settings page
    // shows the row so the user can re-enter the key.
    console.warn(`[aiProviders] could not decrypt the ${row.capability} key for user ${row.userId}; ignoring the config`)
    return null
  }
  return {
    capability: row.capability,
    source: 'user',
    model: row.model,
    credentials: { baseUrl: row.baseUrl, apiKey },
    supportsVision: row.capability === 'chat' && row.supportsVision
  }
}

function fromInstanceDefault(capability: AiCapability): ResolvedAiProvider | null {
  const def = readInstanceDefault(capability)
  if (!def) return null
  return {
    capability,
    source: 'instance',
    model: def.model,
    credentials: def.credentials,
    supportsVision: def.supportsVision
  }
}

export async function resolveAiProviders(userId: number): Promise<ResolvedAiProviders> {
  const rows = await listAiProviders(userId)
  const pick = (capability: AiCapability): ResolvedAiProvider | null => {
    const row = rows.find(r => r.capability === capability)
    return (row ? fromUserRow(row) : null) ?? fromInstanceDefault(capability)
  }
  return { chat: pick('chat'), image: pick('image'), transcription: pick('transcription') }
}

export async function resolveAiProvider(userId: number, capability: AiCapability): Promise<ResolvedAiProvider | null> {
  return (await resolveAiProviders(userId))[capability]
}

/**
 * Live dictation (Voxtral Realtime) is Mistral-only and opens a direct
 * WebSocket to Mistral (LiteLLM can't proxy it). It's available when the
 * transcription provider is Mistral with a key we hold, or when the
 * instance default is a platform alias and the operator configured
 * `MISTRAL_API_KEY` (today's hosted setup).
 */
export interface LiveDictationTarget {
  apiKey: string
  model: string
  /** Platform-paid → bill the per-minute LiteLLM tick against the user's budget. */
  platformBilled: boolean
}

export function liveDictationTarget(transcription: ResolvedAiProvider | null): LiveDictationTarget | null {
  if (!transcription) return null
  const model = realtimeDictationModel()
  if (transcription.credentials) {
    if (baseUrlHost(transcription.credentials.baseUrl) !== MISTRAL_API_HOST) return null
    return { apiKey: transcription.credentials.apiKey, model, platformBilled: false }
  }
  const platformKey = (process.env.MISTRAL_API_KEY ?? '').trim()
  if (!platformKey) return null
  return { apiKey: platformKey, model, platformBilled: true }
}

export function availabilityFrom(providers: ResolvedAiProviders): AiAvailability {
  const status = (p: ResolvedAiProvider | null): AiCapabilityStatus => ({
    available: p !== null,
    source: p ? p.source : 'none',
    platformBilled: isPlatformBilled(p)
  })
  return {
    chat: { ...status(providers.chat), supportsVision: providers.chat?.supportsVision ?? false },
    image: status(providers.image),
    transcription: {
      ...status(providers.transcription),
      liveDictation: liveDictationTarget(providers.transcription) !== null
    }
  }
}
