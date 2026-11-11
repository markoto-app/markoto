// Bring-your-own-key (BYOK) AI provider vocabulary, shared by the
// server (resolution, validation, verification) and the settings UI.
//
// markoto only speaks OpenAI-compatible APIs for BYOK. Three
// capabilities can be configured independently per user:
//
//   - chat          — the agent loop (tool calling, optionally vision),
//                     the `@ai` comment trigger and the web-tool
//                     synthesis sub-calls. Required for any AI feature.
//   - image         — `generate_image` (OpenAI images API). Optional.
//   - transcription — voice prompt (OpenAI `/audio/transcriptions`).
//                     Optional. Live dictation additionally needs a
//                     Mistral key (Voxtral Realtime is Mistral-only).
//
// Embeddings, web search (Staan) and page fetch (Jina Reader) are
// platform-provided and NOT configurable here.
//
// Pure module: no Nuxt, no Node APIs — safe in the browser bundle.

export const AI_CAPABILITIES = ['chat', 'image', 'transcription'] as const
export type AiCapability = typeof AI_CAPABILITIES[number]

export function isAiCapability(value: unknown): value is AiCapability {
  return AI_CAPABILITIES.some(c => c === value)
}

/** Where a capability's provider comes from for one user. */
export type AiProviderSource = 'user' | 'instance' | 'none'

/** Per-capability availability, as served by `GET /api/ai/availability`. */
export interface AiCapabilityStatus {
  available: boolean
  source: AiProviderSource
  /**
   * True when calls are paid by the platform (an operator-configured
   * LiteLLM model alias) and therefore consume the user's AI Points.
   * BYOK calls (own key) never do.
   */
  platformBilled: boolean
  /**
   * `'plan'`: the platform offers this capability, but not on the plan
   * that pays here (WP5) — the UI shows a locked control with an upgrade
   * (or "ask your admin") prompt instead of hiding it. A user's own key
   * always unlocks it.
   */
  locked?: 'plan'
}

export interface AiModelTierStatus {
  /** The user's pick in Settings → AI provider. */
  selected: 'fast' | 'strong'
  /** The platform chat default has a strong variant (and it's in use). */
  strongAvailable: boolean
  /** It exists, but the plan doesn't include it. */
  strongLocked: boolean
}

export interface AiAvailability {
  chat: AiCapabilityStatus & { supportsVision: boolean, modelTier?: AiModelTierStatus }
  image: AiCapabilityStatus
  transcription: AiCapabilityStatus & { liveDictation: boolean }
  /**
   * Platform-provided web tools (Staan search / Jina Reader). `false` when
   * the operator has no upstream key — the tools are then not offered to
   * the AI at all. Independent of the user's chat provider.
   */
  webTools: { search: boolean, fetch: boolean }
}

/** Sanitised view of a stored user provider config. Never carries the key. */
export interface AiProviderConfigView {
  capability: AiCapability
  baseUrl: string
  /** Host of `baseUrl`, for display ("api.mistral.ai"). */
  host: string
  model: string
  /** Last four characters of the API key, for recognition only. */
  apiKeyLast4: string
  supportsVision: boolean
  /** Result of the last verification's tool-calling probe (chat only). */
  supportsTools: boolean | null
  lastVerifiedAt: string | null
  updatedAt: string
}

/** Outcome codes for URL policy refusals (server → UI i18n keys). */
export const URL_REFUSAL_CODES = [
  'invalid',
  'scheme',
  'credentials-in-url',
  'internal-host',
  'not-allowlisted',
  'https-required',
  'private-address',
  'unresolvable'
] as const
export type UrlRefusalCode = typeof URL_REFUSAL_CODES[number]

/** Verification outcome codes (server → UI i18n keys). */
export const VERIFY_CODES = [
  'ok',
  'auth-failed',
  'model-not-found',
  'no-tool-support',
  'url-refused',
  'unreachable',
  'unexpected-response'
] as const
export type VerifyCode = typeof VERIFY_CODES[number]

export interface ProviderPreset {
  id: string
  label: string
  baseUrl: string
  /** Suggested model ids per capability (first = default suggestion). */
  models: Partial<Record<AiCapability, string[]>>
  /** Needs `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS=true` (self-hosted only). */
  local?: boolean
}

/**
 * Known OpenAI-compatible providers. Base URLs verified against each
 * provider's `/models` + `/chat/completions` routes on 2026-10-26.
 * Model suggestions are only listed where docs/AI-MODELS.md names a
 * model for that provider; elsewhere the user types the provider's id.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'mistral',
    label: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    models: {
      chat: ['mistral-small-2603', 'ministral-14b-2512', 'mistral-medium-3-5'],
      transcription: ['voxtral-mini-2602']
    }
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: {
      chat: ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.5'],
      image: ['gpt-image-1'],
      transcription: ['gpt-4o-mini-transcribe', 'whisper-1']
    }
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: { chat: ['moonshotai/kimi-k3.1-pro', 'minimax/minimax-m3.1-flash'] }
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: { transcription: ['whisper-large-v3-turbo'] }
  },
  { id: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', models: {} },
  { id: 'deepinfra', label: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', models: {} },
  { id: 'fireworks', label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', models: {} },
  { id: 'scaleway', label: 'Scaleway (EU)', baseUrl: 'https://api.scaleway.ai/v1', models: {} },
  {
    id: 'ollama',
    label: 'Ollama (self-hosted)',
    baseUrl: 'http://host.docker.internal:11434/v1',
    models: {},
    local: true
  }
]

/**
 * The SaaS allowlist we recommend for `NUXT_AI_BYOK_ALLOWED_BASE_URLS`:
 * every non-local preset above. Self-hosters leave the variable empty
 * (free-form URLs). Kept as data so docs, tests and the default
 * staging/prod env stay in lockstep.
 */
export const RECOMMENDED_SAAS_ALLOWED_BASE_URLS: readonly string[] = PROVIDER_PRESETS
  .filter(p => !p.local)
  .map(p => p.baseUrl)

/** Host whose transcription key also unlocks Voxtral Realtime live dictation. */
const MISTRAL_API_HOST = 'api.mistral.ai'

/**
 * Mistral's EU regional endpoint (inference in EU / EFTA data centres;
 * the global `api.mistral.ai` makes no location commitment). Every call
 * the platform pays — LiteLLM deployments and the live-dictation
 * WebSocket on the operator's key — goes here. A user's own Mistral key
 * works on either host.
 */
export const MISTRAL_EU_API_HOST = 'api.eu.mistral.ai'

/** Hosts whose Mistral transcription key unlocks live dictation (the realtime WS goes to the same host). */
export const MISTRAL_LIVE_DICTATION_HOSTS: readonly string[] = [MISTRAL_API_HOST, MISTRAL_EU_API_HOST]

/**
 * Normalise a provider base URL for storage + comparison: trims
 * whitespace and trailing slashes. Returns null when the input isn't
 * an absolute URL. Does NOT apply any security policy — see
 * `server/utils/aiProviders/urlPolicy.ts` for that.
 */
export function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  const path = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.protocol}//${parsed.host}${path}`
}

/** Host part of a base URL, or '' when unparseable. */
export function baseUrlHost(raw: string): string {
  try {
    return new URL(raw).hostname
  } catch {
    return ''
  }
}

/**
 * i18n key segment for a kebab-case outcome code (`auth-failed` →
 * `authFailed`). Used for `aiProvider.verify.*` / `aiProvider.urlRefused.*`
 * so locale keys stay plain identifiers.
 */
export function codeKey(code: string): string {
  return code.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
}

/** Display mask for an API key: last four characters only. */
export function apiKeyLast4(key: string): string {
  const trimmed = key.trim()
  return trimmed.length <= 4 ? trimmed.replace(/./g, '•') : trimmed.slice(-4)
}
