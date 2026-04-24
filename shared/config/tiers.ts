// Subscription tier caps. Single source of truth for what each plan
// grants; consumed by `nuxt.config.ts` (runtime config), the unit
// tests, and the client-side pricing page. See AGENTS.md §15 for the
// economics these numbers come from.

export type PlanName = 'free' | 'pro' | 'max' | 'ultra'

export interface TierCaps {
  /**
   * AI actions per billing period. Turns count 1; grounded turns,
   * images, and dictation-minutes count 5. See AGENTS.md §15.
   */
  interactionsPerMonth: number
  /** Workspaces this user can OWN. Doesn't limit ones they're invited to. */
  workspacesOwned: number
  /** Knowledge files uploaded across all workspaces this user manages. */
  knowledgeFiles: number
  /** Per-workspace byte cap (one workspace's knowledge corpus). */
  knowledgeBytesPerWorkspace: number
  /** Per-user byte cap summed across every workspace they upload to. */
  knowledgeBytesPerUser: number
  /** Live-dictation audio budget per day, in milliseconds. */
  dictationMsPerDay: number
}

export const TIERS = {
  free: {
    interactionsPerMonth: 100,
    workspacesOwned: 1,
    knowledgeFiles: 5,
    knowledgeBytesPerWorkspace: 50 * 1024 * 1024,
    knowledgeBytesPerUser: 50 * 1024 * 1024,
    dictationMsPerDay: 5 * 60 * 1000
  },
  pro: {
    interactionsPerMonth: 1500,
    workspacesOwned: 10,
    knowledgeFiles: 50,
    knowledgeBytesPerWorkspace: 2 * 1024 * 1024 * 1024,
    knowledgeBytesPerUser: 2 * 1024 * 1024 * 1024,
    dictationMsPerDay: 30 * 60 * 1000
  },
  max: {
    interactionsPerMonth: 8000,
    workspacesOwned: 30,
    knowledgeFiles: 500,
    // Per-workspace cap stays at 1 GB — the cap measures one workspace
    // corpus size, not per-user-total. Max users get more via the
    // per-user cap (10 GB) spread across more workspaces.
    knowledgeBytesPerWorkspace: 1024 * 1024 * 1024,
    knowledgeBytesPerUser: 10 * 1024 * 1024 * 1024,
    dictationMsPerDay: 60 * 60 * 1000
  },
  ultra: {
    interactionsPerMonth: 16000,
    workspacesOwned: 100,
    knowledgeFiles: 2000,
    knowledgeBytesPerWorkspace: 1024 * 1024 * 1024,
    knowledgeBytesPerUser: 50 * 1024 * 1024 * 1024,
    dictationMsPerDay: 60 * 60 * 1000
  }
} as const satisfies Record<PlanName, TierCaps>

export const PLAN_NAMES: readonly PlanName[] = ['free', 'pro', 'max', 'ultra']

/** The "more is better" cap fields — higher on a bigger tier. */
export const MONOTONIC_CAP_FIELDS: readonly (keyof TierCaps)[] = [
  'interactionsPerMonth',
  'workspacesOwned',
  'knowledgeFiles',
  'knowledgeBytesPerUser',
  'dictationMsPerDay'
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
