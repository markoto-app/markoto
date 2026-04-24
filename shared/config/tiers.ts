// Subscription tier caps. Single source of truth for what each plan
// actually grants; consumed by `nuxt.config.ts` (runtime config) and
// the unit test suite, and later by the phase-6 pricing page on the
// client. See AGENTS.md §15 for the economics these numbers come from.
//
// Phase 1 only DEFINES these; nothing reads them yet. Phase 3+ threads
// the lookup through every enforcement site.

export type PlanName = 'free' | 'pro' | 'max' | 'ultra'

export interface TierCaps {
  /**
   * AI actions per calendar month. Turns count 1; grounded turns,
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

// Phase-1 compatibility shims. Existing enforcement sites
// (server/utils/knowledgeQuota.ts, POST /api/workspaces, etc.) still
// read these flat values from runtimeConfig — they become per-tier
// lookups in phases 3/4, at which point these shims AND the tests
// against them get deleted together.
//
// The numbers are chosen to be "at least as permissive as what any
// phase-0 user already had" so nothing regresses at phase-1 boot.
// Unit tests pin this invariant.
export const LEGACY_KNOWLEDGE_SHIM = {
  maxFileBytes: 25 * 1024 * 1024, // 25 MB — unchanged from phase 0
  maxFilesPerWorkspace: 500,
  maxTotalBytesPerWorkspace: 1024 * 1024 * 1024, // 1 GB
  maxFilesPerUser: 100,
  maxTotalBytesPerUser: 2 * 1024 * 1024 * 1024, // 2 GB
  maxChunksPerFile: 300,
  failedRetentionDays: 7
} as const

export const LEGACY_WORKSPACES_SHIM = {
  maxPerUser: 20
} as const

// Stripe runtime-config keys. Populated from env vars in prod; empty
// strings in dev. Mirrored in `nuxt.config.ts` so a single source of
// truth drives both the unit tests and the Nitro runtimeConfig.
//
// `apiBase` is an override used by integration tests (pointed at the
// `stripe-mock` container) and for any future region-swap scenarios.
// Empty string = default SDK behaviour (api.stripe.com).
export const STRIPE_CONFIG_DEFAULTS = {
  secretKey: '',
  webhookSecret: '',
  pricePro: '',
  priceMax: '',
  priceUltra: '',
  apiBase: '',
  // URL users land on after a successful Checkout. Both `{SESSION_ID}`
  // and `{PLAN}` are Stripe's / our own placeholders — substituted
  // before the redirect URL is passed to Stripe.
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
