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
//     deployment in deploy/config/litellm/config.yaml has zero cost, so these
//     calls never debit the user's LiteLLM `max_budget`.
//   - instance default WITHOUT base URL → the model alias as-is
//     (platform-paid, debits the user's budget).
//
// The request still authenticates with the user's LiteLLM virtual key,
// so per-key rpm limits and spend-log tags keep working for BYOK.

import { openProviderKey } from './keyCrypto'
import { listAiProviders, type AiProviderRow } from '../../repos/aiProviders'
import { readInstanceDefault, realtimeDictationModel } from './config'
import { getWebToolAvailability } from '../ai/webTools'
import { planHasFeature } from '../billing/entitlements'
import { getAiModelTier } from '../../repos/users'
import type { FeatureField, PlanName } from '~~/shared/config/tiers'
import type { UserScope } from '../../repos/proofs'
import {
  MISTRAL_EU_API_HOST,
  MISTRAL_LIVE_DICTATION_HOSTS,
  baseUrlHost,
  type AiAvailability,
  type AiCapability,
  type AiCapabilityStatus
} from '~~/shared/ai/providers'
import { useEnv } from '~~/shared/env/load'
import type { RawEnv } from '~~/shared/env/define'
import { useLogger } from '../platform/logger'

const log = useLogger('ai-providers')

/** LiteLLM deployment prefix for clientside-credential (BYOK) calls. */
const BYOK_MODEL_PREFIX = 'byok/'

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
    apiKey = openProviderKey(row)
  } catch {
    // Undecryptable (encryption key lost or rotated away). Treat as
    // unconfigured rather than failing every AI call; the settings page
    // shows the row so the user can re-enter the key.
    log.warn('could not decrypt the stored provider key; ignoring the config', { capability: row.capability, userId: row.userId })
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

/**
 * Plan feature that unlocks a capability on the PLATFORM's provider.
 * Chat on the instance default is in every plan; a user's own key
 * is never gated.
 */
export const CAPABILITY_PLAN_FEATURE: Partial<Record<AiCapability, FeatureField>> = {
  image: 'aiImage',
  transcription: 'aiVoice'
}

/** The stronger platform chat model (`NUXT_AI_DEFAULT_CHAT_STRONG_MODEL`), or null. */
function strongChatModel(source?: RawEnv): string | null {
  return useEnv(source).ai.chatStrongModel || null
}

export interface AiAccess {
  providers: ResolvedAiProviders
  /** Capabilities whose platform default exists but the plan doesn't include. */
  locked: AiCapability[]
  /** Chat model tier in use / available on the platform default. */
  modelTier: { selected: 'fast' | 'strong', strongAvailable: boolean, strongLocked: boolean }
}

/**
 * Resolve the providers for a user under a plan: own config → instance
 * default (only for capabilities the plan includes) → null. `plan` is
 * the plan that pays for the call (`resolveBillingContext(...).plan` —
 * a Team / Business workspace's plan inside it). With the user's "Strong"
 * pick and a plan that includes `aiStrongModel`, the platform chat
 * default becomes `NUXT_AI_DEFAULT_CHAT_STRONG_MODEL`.
 */
export async function resolveAiAccess(user: UserScope, plan: PlanName): Promise<AiAccess> {
  const [rows, userRow] = await Promise.all([
    listAiProviders(user),
    getAiModelTier(user).then(tier => ({ tier }))
  ])
  const locked: AiCapability[] = []
  const pick = (capability: AiCapability): ResolvedAiProvider | null => {
    const row = rows.find(r => r.capability === capability)
    const own = row ? fromUserRow(row) : null
    if (own) return own
    const def = fromInstanceDefault(capability)
    if (!def) return null
    const feature = CAPABILITY_PLAN_FEATURE[capability]
    if (feature && !planHasFeature(plan, feature)) {
      locked.push(capability)
      return null
    }
    return def
  }
  const providers: ResolvedAiProviders = { chat: pick('chat'), image: pick('image'), transcription: pick('transcription') }
  const strong = strongChatModel()
  const strongAllowed = planHasFeature(plan, 'aiStrongModel')
  const selected = userRow?.tier === 'strong' ? 'strong' : 'fast'
  const chat = providers.chat
  const chatIsPlatformAlias = chat !== null && chat.source === 'instance' && chat.credentials === null
  if (chatIsPlatformAlias && strong && strongAllowed && selected === 'strong') {
    providers.chat = { ...chat, model: strong }
  }
  return {
    providers,
    locked,
    modelTier: {
      selected,
      strongAvailable: chatIsPlatformAlias && strong !== null,
      strongLocked: chatIsPlatformAlias && strong !== null && !strongAllowed
    }
  }
}

export async function resolveAiProviders(user: UserScope, plan: PlanName): Promise<ResolvedAiProviders> {
  return (await resolveAiAccess(user, plan)).providers
}

export interface LiveDictationTarget {
  apiKey: string
  model: string
  /** Mistral server the realtime WebSocket connects to (`https://<host>`). */
  serverURL: string
  /** Platform-paid → bill the per-minute LiteLLM tick against the user's budget. */
  platformBilled: boolean
}

export function liveDictationTarget(transcription: ResolvedAiProvider | null): LiveDictationTarget | null {
  if (!transcription) return null
  const model = realtimeDictationModel()
  if (transcription.credentials) {
    // The user's own Mistral key: stream to the host THEY configured
    // (global or EU), under their agreement with Mistral.
    const host = baseUrlHost(transcription.credentials.baseUrl)
    if (!MISTRAL_LIVE_DICTATION_HOSTS.includes(host)) return null
    return { apiKey: transcription.credentials.apiKey, model, serverURL: `https://${host}`, platformBilled: false }
  }
  const platformKey = useEnv().providers.mistralApiKey
  if (!platformKey) return null
  // Operator-paid: always Mistral's EU endpoint, like every LiteLLM
  // Mistral deployment (deploy/config/litellm/config.yaml).
  return { apiKey: platformKey, model, serverURL: `https://${MISTRAL_EU_API_HOST}`, platformBilled: true }
}

export function availabilityFrom(providers: ResolvedAiProviders, access?: Pick<AiAccess, 'locked' | 'modelTier'>): AiAvailability {
  const locked = access?.locked ?? []
  const status = (capability: AiCapability, p: ResolvedAiProvider | null): AiCapabilityStatus => ({
    available: p !== null,
    source: p ? p.source : 'none',
    platformBilled: isPlatformBilled(p),
    ...(locked.includes(capability) ? { locked: 'plan' as const } : {})
  })
  return {
    chat: {
      ...status('chat', providers.chat),
      supportsVision: providers.chat?.supportsVision ?? false,
      modelTier: access?.modelTier ?? { selected: 'fast', strongAvailable: false, strongLocked: false }
    },
    image: status('image', providers.image),
    transcription: {
      ...status('transcription', providers.transcription),
      liveDictation: liveDictationTarget(providers.transcription) !== null
    },
    webTools: getWebToolAvailability()
  }
}
