// Subscription tier caps. Single source of truth for what each plan
// grants; consumed by server enforcement (via
// `server/utils/tierConfig.ts#getTiers()`), the unit tests, and the
// client-side pricing page (via `GET /api/billing/tiers`).
//
// Phase 6 architecture: AI usage is gated SOLELY by per-user LiteLLM
// virtual-key budgets. No per-feature interaction counters, no
// per-minute dictation caps, no rate-limit middleware. The user's
// `litellmBudgetUsd` maps to a `max_budget` on their LiteLLM key;
// every billable operation (chat, image gen, voice tick, embeddings)
// debits that budget directly via LiteLLM's spend tracker. UI surfaces
// budget as "AI Points" at 1000 pts = $1.00 USD (display multiplier
// makes the numbers feel generous; backend math stays in dollars).
//
// Storage caps (knowledge files / bytes) stay because they bind real
// S3 + DB cost, not LLM cost. `workspacesOwned` is a capacity cap.

export type PlanName = 'free' | 'pro' | 'max' | 'ultra'

export interface TierCaps {
  /**
   * Monthly LiteLLM budget in USD. Mapped 1:1 onto the user's virtual
   * key's `max_budget`. Stripe-webhook-driven reset on `invoice.paid`.
   * UI multiplies × 1000 to display "AI Points" (Free=500, Pro=5000,
   * Max=15000, Ultra=35000).
   */
  litellmBudgetUsd: number
  /** Workspaces this user can OWN. Doesn't limit ones they're invited to. */
  workspacesOwned: number
  /** Knowledge files uploaded across all workspaces this user manages. */
  knowledgeFiles: number
  /** Per-workspace byte cap (one workspace's knowledge corpus). */
  knowledgeBytesPerWorkspace: number
  /** Per-user byte cap summed across every workspace they upload to. */
  knowledgeBytesPerUser: number
}

// Committed values are the SELF-HOSTER DEFAULTS. The hosted deployment
// can override any individual cap at runtime via `TIER_*` env vars
// (see `resolveTiersFromEnv` below) without a code change — e.g.
// `TIER_PRO_LITELLM_BUDGET_USD=8`. Server enforcement resolves through
// `server/utils/tierConfig.ts#getTiers()`; the client fetches the
// resolved map from `GET /api/billing/tiers`.
export const DEFAULT_TIERS = {
  free: {
    litellmBudgetUsd: 1, // 500 AI Points
    workspacesOwned: 1,
    knowledgeFiles: 5,
    knowledgeBytesPerWorkspace: 50 * 1024 * 1024,
    knowledgeBytesPerUser: 50 * 1024 * 1024
  },
  pro: {
    litellmBudgetUsd: 5, // 5000 AI Points
    workspacesOwned: 10,
    knowledgeFiles: 50,
    knowledgeBytesPerWorkspace: 2 * 1024 * 1024 * 1024,
    knowledgeBytesPerUser: 2 * 1024 * 1024 * 1024
  },
  max: {
    litellmBudgetUsd: 15, // 15000 AI Points
    workspacesOwned: 30,
    knowledgeFiles: 500,
    // Per-workspace cap stays at 1 GB — the cap measures one workspace
    // corpus size, not per-user-total. Max users get more via the
    // per-user cap (10 GB) spread across more workspaces.
    knowledgeBytesPerWorkspace: 1024 * 1024 * 1024,
    knowledgeBytesPerUser: 10 * 1024 * 1024 * 1024
  },
  ultra: {
    litellmBudgetUsd: 35, // 35000 AI Points
    workspacesOwned: 100,
    knowledgeFiles: 2000,
    knowledgeBytesPerWorkspace: 1024 * 1024 * 1024,
    knowledgeBytesPerUser: 50 * 1024 * 1024 * 1024
  }
} as const satisfies Record<PlanName, TierCaps>

export const PLAN_NAMES: readonly PlanName[] = ['free', 'pro', 'max', 'ultra']

/** A fully-resolved tier map (defaults + any runtime overrides). */
export type TiersMap = Record<PlanName, TierCaps>

// Env-var suffix for each overridable cap field. Explicit table (no
// case-conversion magic) so the mapping is greppable in both directions.
const TIER_FIELD_ENV_SUFFIX: Record<keyof TierCaps, string> = {
  litellmBudgetUsd: 'LITELLM_BUDGET_USD',
  workspacesOwned: 'WORKSPACES_OWNED',
  knowledgeFiles: 'KNOWLEDGE_FILES',
  knowledgeBytesPerWorkspace: 'KNOWLEDGE_BYTES_PER_WORKSPACE',
  knowledgeBytesPerUser: 'KNOWLEDGE_BYTES_PER_USER'
}

/**
 * Resolve the effective tier map from an env-shaped record. Pure — no
 * process.env access — so every test tier can drive it directly.
 *
 * Override key shape: `TIER_<PLAN>_<FIELD>`, e.g.
 * `TIER_FREE_LITELLM_BUDGET_USD=2`, `TIER_ULTRA_KNOWLEDGE_FILES=5000`.
 * Only positive finite numbers are accepted; anything else (absent,
 * empty, NaN, zero, negative) leaves the committed default in place —
 * a typo'd override must degrade to the default, never to a disabled
 * product.
 */
export function resolveTiersFromEnv(
  env: Record<string, string | undefined>
): TiersMap {
  const resolved = {} as Record<PlanName, TierCaps>
  for (const plan of PLAN_NAMES) {
    const caps = { ...DEFAULT_TIERS[plan] } as TierCaps
    for (const field of Object.keys(TIER_FIELD_ENV_SUFFIX) as (keyof TierCaps)[]) {
      const raw = env[`TIER_${plan.toUpperCase()}_${TIER_FIELD_ENV_SUFFIX[field]}`]
      if (raw === undefined || raw === '') continue
      const value = Number(raw)
      if (Number.isFinite(value) && value > 0) caps[field] = value
    }
    resolved[plan] = caps
  }
  return resolved
}

/** The "more is better" cap fields — higher on a bigger tier. */
export const MONOTONIC_CAP_FIELDS: readonly (keyof TierCaps)[] = [
  'litellmBudgetUsd',
  'workspacesOwned',
  'knowledgeFiles',
  'knowledgeBytesPerUser'
]

// Platform constraints that don't vary by plan. Grouped here alongside
// the tier caps because both feed knowledge-upload enforcement.
export const KNOWLEDGE_PLATFORM_LIMITS = {
  /** Per-file size ceiling. Matches markitdown's conversion budget. */
  maxFileBytes: 25 * 1024 * 1024,
  /** Chunker ceiling so a pathological input can't blow the embedding bill. */
  maxChunksPerFile: 300,
  /** `status='failed'` TTL before the sweep reaps the row + its S3 bytes. */
  failedRetentionDays: 7
} as const

// Stripe runtime-config keys. Populated from env vars in prod; empty
// strings in dev. Mirrored in `nuxt.config.ts` so a single source of
// truth drives both the unit tests and the Nitro runtimeConfig.
//
// `apiBase` is an override used by integration tests (pointed at the
// `stripe-mock` container). Empty string = default SDK behaviour
// (api.stripe.com).
export const STRIPE_CONFIG_DEFAULTS = {
  secretKey: '',
  webhookSecret: '',
  pricePro: '',
  priceMax: '',
  priceUltra: '',
  apiBase: '',
  successUrl: '/pricing?checkout=success&session={CHECKOUT_SESSION_ID}',
  cancelUrl: '/pricing?checkout=cancelled'
} as const

export const STRIPE_CONFIG_KEYS = [
  'secretKey',
  'webhookSecret',
  'pricePro',
  'priceMax',
  'priceUltra',
  'apiBase',
  'successUrl',
  'cancelUrl'
] as const
