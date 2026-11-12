// Operator configuration for AI providers, read from the typed env
// (shared/env) on every call: the resolver runs in the repos/unit test
// tiers outside a Nitro context, and tests flip the env per case.
//
// Instance defaults (self-hosters; the SaaS sets none):
//
//   NUXT_AI_DEFAULT_CHAT_MODEL / _BASE_URL / _API_KEY / _VISION
//   NUXT_AI_DEFAULT_IMAGE_MODEL / _BASE_URL / _API_KEY
//   NUXT_AI_DEFAULT_TRANSCRIBE_MODEL / _BASE_URL / _API_KEY
//
// Semantics per capability:
//   - MODEL unset                → no instance default.
//   - MODEL set, BASE_URL unset  → MODEL is a model alias defined in the
//     operator's LiteLLM `config.yaml` (e.g. `mistral-small-2603`). The
//     call is platform-paid and debits the user's LiteLLM budget.
//   - MODEL + BASE_URL + API_KEY → routed through the zero-cost `byok/*`
//     deployment with clientside credentials, exactly like a user key.
//   - BASE_URL without API_KEY   → misconfiguration; treated as unset
//     (and reported as a boot warning, shared/env/rules/ai.ts).
//
// BYOK URL policy:
//   NUXT_AI_BYOK_ALLOWED_BASE_URLS   comma-separated allowlist (SaaS);
//                                    empty = any public URL (self-host)
//   NUXT_AI_BYOK_ALLOW_PRIVATE_URLS  true = allow private-network
//                                    endpoints (Ollama, vLLM); default off

import { normalizeBaseUrl, type AiCapability } from '~~/shared/ai/providers'
import { useEnv } from '~~/shared/env/load'
import { ai } from '~~/shared/env/vars/ai'
import type { RawEnv } from '~~/shared/env/define'
import type { ByokUrlPolicy } from './urlPolicy'

/** Default Voxtral Realtime model for live dictation (overridable via `NUXT_AI_REALTIME_MODEL`). */
export const DEFAULT_REALTIME_MODEL = ai.vars.realtimeModel.default

export interface InstanceDefault {
  capability: AiCapability
  model: string
  /** null = LiteLLM model alias (platform-paid). */
  credentials: { baseUrl: string, apiKey: string } | null
  supportsVision: boolean
}

function configured(capability: AiCapability, source: RawEnv | undefined): { model: string, baseUrl?: string, apiKey?: string, vision: boolean } {
  const { ai } = useEnv(source)
  switch (capability) {
    case 'chat': return { model: ai.chatModel, baseUrl: ai.chatBaseUrl, apiKey: ai.chatApiKey, vision: ai.chatVision }
    case 'image': return { model: ai.imageModel, baseUrl: ai.imageBaseUrl, apiKey: ai.imageApiKey, vision: false }
    case 'transcription': return { model: ai.transcribeModel, baseUrl: ai.transcribeBaseUrl, apiKey: ai.transcribeApiKey, vision: false }
  }
}

export function readInstanceDefault(capability: AiCapability, source?: RawEnv): InstanceDefault | null {
  const { model, baseUrl: baseUrlRaw, apiKey, vision } = configured(capability, source)
  if (!model) return null
  // Vision defaults ON for chat (the bundled Mistral Small alias has it);
  // an operator pointing at a text-only model sets `_VISION=false`.
  const supportsVision = capability === 'chat' && vision
  if (!baseUrlRaw) return { capability, model, credentials: null, supportsVision }
  const baseUrl = normalizeBaseUrl(baseUrlRaw)
  // Half-configured (no key): ignored, and reported as a boot warning
  // (shared/env/rules/ai.ts).
  if (!baseUrl || !apiKey) return null
  return { capability, model, credentials: { baseUrl, apiKey }, supportsVision }
}

export function resolveByokUrlPolicy(source?: RawEnv): ByokUrlPolicy {
  const { ai } = useEnv(source)
  return {
    allowedBaseUrls: ai.byokAllowedBaseUrls
      .map(entry => normalizeBaseUrl(entry))
      .filter((entry): entry is string => entry !== null),
    allowPrivate: ai.byokAllowPrivateUrls
  }
}

/**
 * Policy applied to operator-configured instance defaults. The operator
 * is trusted to pick the endpoint (no allowlist, private networks OK —
 * e.g. `http://ollama:11434/v1` on the compose network), but the
 * internal-service and loopback/metadata refusals still apply.
 */
export const OPERATOR_URL_POLICY: ByokUrlPolicy = Object.freeze({ allowedBaseUrls: [], allowPrivate: true })

/**
 * Model id for Voxtral Realtime live dictation. Only used when the
 * transcription provider is Mistral (own key or instance default).
 */
export function realtimeDictationModel(source?: RawEnv): string {
  return useEnv(source).ai.realtimeModel
}
