// Subscription tier caps. Single source of truth for what each plan
// grants; consumed by `nuxt.config.ts` (runtime config), the unit
// tests, and the client-side pricing page.
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

export const TIERS = {
  free: {
    litellmBudgetUsd: 1.0, // 500 AI Points
    workspacesOwned: 1,
    knowledgeFiles: 5,
    knowledgeBytesPerWorkspace: 50 * 1024 * 1024,
    knowledgeBytesPerUser: 50 * 1024 * 1024
  },
  pro: {
    litellmBudgetUsd: 5.0, // 5000 AI Points
    workspacesOwned: 10,
    knowledgeFiles: 50,
    knowledgeBytesPerWorkspace: 2 * 1024 * 1024 * 1024,
    knowledgeBytesPerUser: 2 * 1024 * 1024 * 1024
  },
  max: {
    litellmBudgetUsd: 15.0, // 15000 AI Points
    workspacesOwned: 30,
    knowledgeFiles: 500,
    // Per-workspace cap stays at 1 GB — the cap measures one workspace
    // corpus size, not per-user-total. Max users get more via the
    // per-user cap (10 GB) spread across more workspaces.
    knowledgeBytesPerWorkspace: 1024 * 1024 * 1024,
    knowledgeBytesPerUser: 10 * 1024 * 1024 * 1024
  },
  ultra: {
    litellmBudgetUsd: 35.0, // 35000 AI Points
    workspacesOwned: 100,
    knowledgeFiles: 2000,
    knowledgeBytesPerWorkspace: 1024 * 1024 * 1024,
    knowledgeBytesPerUser: 50 * 1024 * 1024 * 1024
  }
} as const satisfies Record<PlanName, TierCaps>

export const PLAN_NAMES: readonly PlanName[] = ['free', 'pro', 'max', 'ultra']

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
