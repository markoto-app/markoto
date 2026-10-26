// Operator configuration for AI providers, read from `process.env` on
// every call (same reasoning as `billingMode.ts`: the resolver runs in
// the repos/unit test tiers outside a Nitro context, and tests flip the
// env per case).
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
//     (and reported by `instanceDefaultProblems` at boot).
//
// BYOK URL policy:
//   NUXT_AI_BYOK_ALLOWED_BASE_URLS   comma-separated allowlist (SaaS);
//                                    empty = any public URL (self-host)
//   NUXT_AI_BYOK_ALLOW_PRIVATE_URLS  true = allow private-network
//                                    endpoints (Ollama, vLLM); default off

import { normalizeBaseUrl, type AiCapability } from '~~/shared/ai/providers'
import { parseBooleanFlag } from '~~/shared/config/billingMode'
import type { ByokUrlPolicy } from './urlPolicy'

/** Default Voxtral Realtime model for live dictation (overridable via `NUXT_AI_REALTIME_MODEL`). */
export const DEFAULT_REALTIME_MODEL = 'voxtral-mini-transcribe-realtime-2602'

type Env = Record<string, string | undefined>

const ENV_PREFIX: Record<AiCapability, string> = {
  chat: 'NUXT_AI_DEFAULT_CHAT',
  image: 'NUXT_AI_DEFAULT_IMAGE',
  transcription: 'NUXT_AI_DEFAULT_TRANSCRIBE'
}

export interface InstanceDefault {
  capability: AiCapability
  model: string
  /** null = LiteLLM model alias (platform-paid). */
  credentials: { baseUrl: string, apiKey: string } | null
  supportsVision: boolean
}

function clean(raw: string | undefined): string {
  return (raw ?? '').trim()
}

export function readInstanceDefault(capability: AiCapability, env: Env = process.env): InstanceDefault | null {
  const prefix = ENV_PREFIX[capability]
  const model = clean(env[`${prefix}_MODEL`])
  if (!model) return null
  const baseUrlRaw = clean(env[`${prefix}_BASE_URL`])
  const apiKey = clean(env[`${prefix}_API_KEY`])
  // Vision defaults ON for chat (the bundled Mistral Small alias has it);
  // an operator pointing at a text-only model sets `_VISION=false`.
  const visionRaw = env[`${prefix}_VISION`]
  const supportsVision = capability === 'chat' && (visionRaw === undefined || visionRaw.trim() === '' || parseBooleanFlag(visionRaw))
  if (!baseUrlRaw) return { capability, model, credentials: null, supportsVision }
  const baseUrl = normalizeBaseUrl(baseUrlRaw)
  if (!baseUrl || !apiKey) return null
  return { capability, model, credentials: { baseUrl, apiKey }, supportsVision }
}

/** Human-readable misconfigurations, logged once at boot. Never includes key material. */
export function instanceDefaultProblems(env: Env = process.env): string[] {
  const problems: string[] = []
  for (const [capability, prefix] of Object.entries(ENV_PREFIX)) {
    const model = clean(env[`${prefix}_MODEL`])
    const baseUrl = clean(env[`${prefix}_BASE_URL`])
    const apiKey = clean(env[`${prefix}_API_KEY`])
    if (!model && (baseUrl || apiKey)) {
      problems.push(`${prefix}_BASE_URL/_API_KEY set without ${prefix}_MODEL — the ${capability} default is ignored.`)
    } else if (model && baseUrl && !apiKey) {
      problems.push(`${prefix}_BASE_URL set without ${prefix}_API_KEY — the ${capability} default is ignored (use any placeholder key for servers that need none).`)
    } else if (model && baseUrl && !normalizeBaseUrl(baseUrl)) {
      problems.push(`${prefix}_BASE_URL is not an absolute URL — the ${capability} default is ignored.`)
    }
  }
  return problems
}

export function resolveByokUrlPolicy(env: Env = process.env): ByokUrlPolicy {
  const allowedBaseUrls = clean(env.NUXT_AI_BYOK_ALLOWED_BASE_URLS)
    .split(',')
    .map(entry => normalizeBaseUrl(entry))
    .filter((entry): entry is string => entry !== null)
  return {
    allowedBaseUrls,
    allowPrivate: parseBooleanFlag(env.NUXT_AI_BYOK_ALLOW_PRIVATE_URLS)
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
export function realtimeDictationModel(env: Env = process.env): string {
  return clean(env.NUXT_AI_REALTIME_MODEL) || DEFAULT_REALTIME_MODEL
}
