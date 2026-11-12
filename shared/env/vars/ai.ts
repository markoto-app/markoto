import { bool, csv, int, nonNegativeInt, number, oneOf, positiveInt, secret, string, url } from '../coerce'
import { defineNamespace, v } from '../define'

const autoSwitch = oneOf(['auto', 'true', 'false'])

export const litellm = defineNamespace({
  name: 'litellm',
  title: 'LiteLLM proxy',
  intro: 'Every platform-paid AI call goes through the self-hosted LiteLLM proxy (infra/litellm/). Per-user virtual keys carry the budgets.',
  vars: {
    url: v({
      name: 'NUXT_LITELLM_URL',
      type: url(),
      required: 'always',
      example: 'http://localhost:4000',
      doc: 'Internal URL of the proxy.',
      services: ['app'],
      scope: 'both'
    }),
    masterKey: v({
      name: 'NUXT_LITELLM_MASTER_KEY',
      example: '',
      type: secret(),
      required: 'always',
      secret: true,
      doc: 'Admin key the app mints virtual keys with; must equal LITELLM_MASTER_KEY.',
      services: ['app'],
      scope: 'both'
    }),
    proxyMasterKey: v({
      name: 'LITELLM_MASTER_KEY',
      example: '',
      type: secret(),
      required: 'always',
      secret: true,
      doc: 'Master key the proxy starts with (sk-…).',
      services: ['litellm', 'compose'],
      scope: 'both'
    }),
    saltKey: v({
      name: 'LITELLM_SALT_KEY',
      example: '',
      type: secret(16),
      secret: true,
      doc: 'Encrypts provider keys in LiteLLM\'s database; the app derives the key that encrypts stored virtual-key tokens from it. Never change it on a running instance (scripts/rotate-litellm-salt.ts).',
      services: ['app', 'litellm'],
      scope: 'both',
      required: { when: 'a virtual-key token is stored or read (any AI use)' }
    }),
    dbUrl: v({
      name: 'NUXT_LITELLM_DB_URL',
      type: url(['postgres', 'postgresql']),
      doc: 'Full URL of LiteLLM\'s spend database for the app\'s spend reads; empty = built from the parts below + POSTGRES_HOST/PORT.',
      services: ['app'],
      scope: 'both',
      notPassed: 'the compose files pass the parts instead'
    }),
    dbUser: v({
      name: 'NUXT_LITELLM_DB_USER',
      type: string,
      doc: 'Role the app reads LiteLLM\'s spend logs as; empty = POSTGRES_USER (and POSTGRES_PASSWORD).',
      services: ['app'],
      scope: 'both'
    }),
    dbPassword: v({
      name: 'NUXT_LITELLM_DB_PASSWORD',
      type: string,
      secret: true,
      doc: 'Password of NUXT_LITELLM_DB_USER.',
      services: ['app'],
      scope: 'both'
    }),
    dbName: v({
      name: 'NUXT_LITELLM_DB_NAME',
      type: string,
      default: 'litellm',
      doc: 'LiteLLM\'s database name.',
      services: ['app'],
      scope: 'both',
      notPassed: 'the stacks use the default'
    }),
    embeddingsModel: v({
      name: 'NUXT_LITELLM_EMBEDDINGS_MODEL',
      type: string,
      default: 'jina-embeddings-v5-text-nano',
      doc: 'Embedding model alias for the knowledge base; `custom-embeddings` = the EMBEDDINGS_UPSTREAM_* deployment.',
      services: ['app'],
      scope: 'self-host'
    }),
    embeddingsDims: v({
      name: 'NUXT_LITELLM_EMBEDDINGS_DIMS',
      type: int({ min: 1, max: 2000 }),
      default: 768,
      doc: 'Embedding size (the pgvector column is retyped at boot while empty; else `bun run knowledge:reembed`).',
      services: ['app'],
      scope: 'self-host'
    }),
    embeddingsSendDimensions: v({
      name: 'NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS',
      type: autoSwitch,
      default: 'auto',
      doc: 'Send the OpenAI `dimensions` parameter (auto = Jina models only).',
      services: ['app'],
      scope: 'self-host'
    }),
    embeddingsTaskHints: v({
      name: 'NUXT_LITELLM_EMBEDDINGS_TASK_HINTS',
      type: autoSwitch,
      default: 'auto',
      doc: 'Send Jina\'s `task` parameter (auto = Jina models only).',
      services: ['app'],
      scope: 'self-host'
    }),
    embeddingsUpstreamModel: v({
      name: 'NUXT_LITELLM_EMBEDDINGS_UPSTREAM_MODEL',
      type: string,
      default: '',
      doc: 'Label only (stored with the vectors): mirrors the proxy\'s EMBEDDINGS_UPSTREAM_MODEL.',
      services: ['app'],
      scope: 'self-host'
    }),
    upstreamModel: v({
      name: 'EMBEDDINGS_UPSTREAM_MODEL',
      type: string,
      doc: 'LiteLLM model id behind `custom-embeddings` (e.g. openai/text-embedding-3-small).',
      services: ['litellm'],
      scope: 'self-host'
    }),
    upstreamApiBase: v({
      name: 'EMBEDDINGS_UPSTREAM_API_BASE',
      type: string,
      doc: 'API base of the custom embeddings upstream.',
      services: ['litellm'],
      scope: 'self-host'
    }),
    upstreamApiKey: v({
      name: 'EMBEDDINGS_UPSTREAM_API_KEY',
      type: string,
      secret: true,
      doc: 'API key of the custom embeddings upstream.',
      services: ['litellm'],
      scope: 'self-host'
    }),
    imageDefaultWidth: v({
      name: 'NUXT_LITELLM_IMAGE_DEFAULT_WIDTH',
      type: positiveInt,
      default: 1024,
      doc: 'Default width of generated images.',
      services: ['app'],
      scope: 'both',
      notPassed: 'tuning knob, default is fine'
    }),
    imageDefaultHeight: v({
      name: 'NUXT_LITELLM_IMAGE_DEFAULT_HEIGHT',
      type: positiveInt,
      default: 1024,
      doc: 'Default height of generated images.',
      services: ['app'],
      scope: 'both',
      notPassed: 'tuning knob, default is fine'
    }),
    realtimeTickModel: v({
      name: 'NUXT_LITELLM_REALTIME_TICK_MODEL',
      type: string,
      default: 'voxtral-realtime-tick',
      doc: 'Metering model billed once per minute of live dictation.',
      services: ['app'],
      scope: 'both',
      notPassed: 'matches infra/litellm/config.yaml'
    })
  }
})

export const providers = defineNamespace({
  name: 'providers',
  title: 'AI provider keys',
  intro: 'Platform-paid upstreams. MISTRAL / BFL / JINA are read by LiteLLM; JINA (fetch_url), STAAN (web_search) and MISTRAL (live dictation) also by the app.',
  vars: {
    jinaApiKey: v({
      name: 'JINA_AI_API_KEY',
      example: '',
      type: string,
      secret: true,
      doc: 'Jina: embeddings (proxy) and the fetch_url tool (app). Empty = fetch_url not offered.',
      services: ['app', 'litellm'],
      scope: 'both'
    }),
    mistralApiKey: v({
      name: 'MISTRAL_API_KEY',
      example: '',
      type: string,
      secret: true,
      doc: 'Mistral (EU endpoint): chat / transcription deployments (proxy) and live dictation on the platform default (app).',
      services: ['app', 'litellm'],
      scope: 'both'
    }),
    bflApiKey: v({
      name: 'BFL_API_KEY',
      example: '',
      type: string,
      secret: true,
      doc: 'Black Forest Labs image generation (proxy only).',
      services: ['litellm'],
      scope: 'both'
    }),
    staanApiKey: v({
      name: 'STAAN_API_KEY',
      example: '',
      type: string,
      secret: true,
      doc: 'Staan web search for the web_search tool. Empty = web_search not offered.',
      services: ['app'],
      scope: 'both'
    }),
    webToolsHourlyLimit: v({
      name: 'NUXT_WEB_TOOLS_HOURLY_LIMIT',
      type: nonNegativeInt,
      default: 30,
      doc: 'web_search + fetch_url calls per user per rolling hour (0 = unlimited).',
      services: ['app'],
      scope: 'both'
    }),
    webToolsDailyLimit: v({
      name: 'NUXT_WEB_TOOLS_DAILY_LIMIT',
      type: nonNegativeInt,
      default: 100,
      doc: 'web_search + fetch_url calls per user per rolling day (0 = unlimited).',
      services: ['app'],
      scope: 'both'
    })
  }
})

function instanceDefault(capability: 'CHAT' | 'IMAGE' | 'TRANSCRIBE', what: string) {
  const prefix = `NUXT_AI_DEFAULT_${capability}`
  return {
    model: v({
      name: `${prefix}_MODEL`,
      type: string,
      default: '',
      doc: `Instance default for ${what}: a LiteLLM alias (platform-paid), or with _BASE_URL + _API_KEY any OpenAI-compatible model. Empty = none.`,
      services: ['app'],
      scope: 'both'
    }),
    baseUrl: v({
      name: `${prefix}_BASE_URL`,
      type: url(),
      doc: `OpenAI-compatible endpoint of the ${what} default (needs _MODEL and _API_KEY).`,
      services: ['app'],
      scope: 'self-host'
    }),
    apiKey: v({
      name: `${prefix}_API_KEY`,
      type: string,
      secret: true,
      doc: `API key for ${prefix}_BASE_URL (any placeholder for servers that need none).`,
      services: ['app'],
      scope: 'self-host'
    })
  }
}

const chat = instanceDefault('CHAT', 'chat')
const image = instanceDefault('IMAGE', 'image generation')
const transcribe = instanceDefault('TRANSCRIBE', 'transcription')

export const ai = defineNamespace({
  name: 'ai',
  title: 'AI defaults and bring-your-own-key',
  intro: 'Per request: the user\'s own provider → the instance default below → unavailable. See docs/AI-MODELS.md.',
  vars: {
    chatModel: chat.model,
    chatBaseUrl: chat.baseUrl,
    chatApiKey: chat.apiKey,
    chatVision: v({
      name: 'NUXT_AI_DEFAULT_CHAT_VISION',
      type: bool,
      default: true,
      doc: 'The chat default accepts images (view_image / view_pages).',
      services: ['app'],
      scope: 'both'
    }),
    chatStrongModel: v({
      name: 'NUXT_AI_DEFAULT_CHAT_STRONG_MODEL',
      type: string,
      default: '',
      doc: 'Stronger LiteLLM chat alias users may pick when their plan has aiStrongModel. Empty = default model only.',
      services: ['app'],
      scope: 'both'
    }),
    imageModel: image.model,
    imageBaseUrl: image.baseUrl,
    imageApiKey: image.apiKey,
    transcribeModel: transcribe.model,
    transcribeBaseUrl: transcribe.baseUrl,
    transcribeApiKey: transcribe.apiKey,
    realtimeModel: v({
      name: 'NUXT_AI_REALTIME_MODEL',
      type: string,
      default: 'voxtral-mini-transcribe-realtime-2602',
      doc: 'Voxtral Realtime model for live dictation (Mistral only).',
      services: ['app'],
      scope: 'both'
    }),
    byokAllowedBaseUrls: v({
      name: 'NUXT_AI_BYOK_ALLOWED_BASE_URLS',
      type: csv(url()),
      default: [],
      doc: 'Allowlist of provider base URLs users may configure. Empty = any public URL. Required with NUXT_LEGAL_SURFACES_ENABLED=true.',
      services: ['app'],
      scope: 'both',
      required: { when: 'NUXT_LEGAL_SURFACES_ENABLED=true' }
    }),
    byokAllowPrivateUrls: v({
      name: 'NUXT_AI_BYOK_ALLOW_PRIVATE_URLS',
      type: bool,
      default: false,
      doc: 'Let users point at private-network providers (Ollama, vLLM). Self-host only.',
      services: ['app'],
      scope: 'both'
    }),
    freeTierTotalBudgetUsd: v({
      name: 'NUXT_FREE_TIER_TOTAL_BUDGET_USD',
      type: number({ min: 0 }),
      default: 0,
      doc: 'Monthly ceiling (USD) on platform-paid AI of all free-tier users together (LiteLLM team budget). 0 = none.',
      services: ['app'],
      scope: 'both'
    })
  }
})
