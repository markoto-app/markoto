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

// Free and Pro are PERSONAL plans (`users.plan`); Team and Business are
// WORKSPACE subscriptions (`workspace_subscriptions`), billed per seat.
// For Team / Business the per-user style caps (`litellmBudgetUsd`,
// knowledge, images) are PER SEAT; the workspace pools them (WP3).
export type PlanName = 'free' | 'pro' | 'team' | 'business'
export type PersonalPlanName = 'free' | 'pro'
export type WorkspacePlanName = 'team' | 'business'

export function isWorkspacePlan(plan: PlanName): plan is WorkspacePlanName {
  return plan === 'team' || plan === 'business'
}

/** Order of the plans, lowest first (for "the better of two plans"). */
export function planRank(plan: PlanName): number {
  return PLAN_NAMES.indexOf(plan)
}

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
  /**
   * Per-user byte cap on document images (own uploads, AI-generated
   * images, and the copies a duplicated doc gets), summed over every
   * document. A pending upload counts from the moment its presigned URL
   * is issued, so parallel requests can't overshoot.
   */
  imageBytesPerUser: number
  /**
   * People in one workspace: accepted members plus open invitations.
   * Judged against the WORKSPACE's plan (see
   * `server/utils/entitlements.ts#resolveWorkspacePlan`). `null` = no
   * plan limit (the platform-wide invite caps still apply).
   */
  membersPerWorkspace: number | null
  /**
   * How far back the Activity Log can be viewed, diffed and restored,
   * in days. Older rows stay stored; they reappear after an upgrade.
   * Judged against the DOCUMENT's plan. `null` = no limit.
   */
  historyDays: number | null
  /** Saved theme presets per user (`themes` table). */
  savedThemes: number
  /**
   * Largest file `/api/import` converts, in bytes. Capped by the
   * platform ceiling in `server/api/import.post.ts` (markitdown's 50 MB).
   */
  importMaxBytes: number
  /**
   * Platform-paid `web_search` + `fetch_url` calls per user per day,
   * on top of the operator ceiling `NUXT_WEB_TOOLS_DAILY_LIMIT`
   * (the stricter one wins). `null` = no plan limit.
   */
  webToolsPerDay: number | null
  /** MCP tool calls per user per day. `null` = no plan limit. */
  mcpToolCallsPerDay: number | null
  /**
   * Feature switch: documents may carry `theme.customCss`. Judged
   * against the DOCUMENT's plan; when off the stored CSS is kept but
   * not applied (preview + PDF) and new writes are refused.
   */
  customCss: boolean
  /**
   * Feature switch: MCP clients may call tools that change content or
   * cost the platform money. Off = read-only MCP (see
   * `server/mcp/lib/toolClasses.ts`).
   */
  mcpWrite: boolean
  /**
   * Feature switch: AI image generation on the PLATFORM's provider
   * (the operator's `NUXT_AI_DEFAULT_IMAGE_*`). A user's own key always
   * works. Off = the default isn't offered (a locked state in the UI).
   */
  aiImage: boolean
  /** Feature switch: voice prompts + live dictation on the platform's provider. */
  aiVoice: boolean
  /**
   * Feature switch: the user may pick the stronger platform chat model
   * (`NUXT_AI_DEFAULT_CHAT_STRONG_MODEL`) in Settings → AI provider.
   */
  aiStrongModel: boolean
  /**
   * Feature switch: the workspace may connect its own identity provider
   * (SAML / OIDC single sign-on + SCIM, WP14). Judged against the
   * WORKSPACE's plan. On in every committed tier (self-hosters); on
   * markoto.app only Business has it (`TIER_{FREE,PRO,TEAM}_FEATURE_SSO=false`
   * in infra/render-env.sh).
   */
  sso: boolean
  /**
   * Feature switch: workspace admins see and export the workspace's
   * audit log (WP15). Judged against the WORKSPACE's plan. On in every
   * committed tier; markoto.app: Business only.
   */
  auditLog: boolean
  /**
   * Feature switch: the workspace may invite guests (WP11) — people who
   * see only the documents shared with them, take no seat (up to
   * `GUESTS_PER_SEAT` per paid seat). Judged against the WORKSPACE's
   * plan. On in every committed tier; markoto.app: Team + Business.
   */
  guests: boolean
  /**
   * Feature switch: the workspace brand kit (WP10) — uploaded fonts and
   * logos, the locked workspace design, workspace templates. Judged
   * against the WORKSPACE's plan. On in every committed tier;
   * markoto.app: Team + Business.
   */
  brandKit: boolean
  /**
   * Feature switch: share-link controls (WP9) — link expiry, view-only
   * without download / print, view counts. Judged against the DOCUMENT's
   * plan (workspace plan, else the owner's). On in every committed tier;
   * markoto.app: Pro and up.
   */
  shareControls: boolean
  /**
   * Feature switch: custom domains for published web pages (WP13).
   * Judged against the plan of the user who adds the domain. Publishing at
   * `/p/<slug>` is free; a domain of one's own is not. On in every
   * committed tier; markoto.app: Pro and up.
   */
  customDomains: boolean
}

/** Numeric cap fields that accept `unlimited` (stored as `null`). */
export type UnlimitedCapField = 'membersPerWorkspace' | 'historyDays' | 'webToolsPerDay' | 'mcpToolCallsPerDay'
/** On/off feature switches. */
export type FeatureField = 'customCss' | 'mcpWrite' | 'aiImage' | 'aiVoice' | 'aiStrongModel' | 'sso' | 'auditLog' | 'guests' | 'brandKit' | 'shareControls' | 'customDomains'
/** Plain positive-number cap fields. */
export type NumericCapField = Exclude<keyof TierCaps, UnlimitedCapField | FeatureField>

export const UNLIMITED_CAP_FIELDS: readonly UnlimitedCapField[] = [
  'membersPerWorkspace',
  'historyDays',
  'webToolsPerDay',
  'mcpToolCallsPerDay'
]

export const FEATURE_FIELDS: readonly FeatureField[] = ['customCss', 'mcpWrite', 'aiImage', 'aiVoice', 'aiStrongModel', 'sso', 'auditLog', 'guests', 'brandKit', 'shareControls', 'customDomains']

/**
 * Whether `used` more units still fit under `limit` (`null` = no limit).
 * `wouldExceed(3, 3)` is true: a fourth member doesn't fit under 3.
 */
export function wouldExceed(limit: number | null, used: number): boolean {
  return limit !== null && used >= limit
}

const MB = 1024 * 1024

// Paid-plan values of the Phase-A entitlements (no limit, every feature).
const PAID_PLAN_ENTITLEMENTS = {
  membersPerWorkspace: null,
  historyDays: null,
  savedThemes: 200,
  importMaxBytes: 50 * MB,
  webToolsPerDay: null,
  mcpToolCallsPerDay: null,
  customCss: true,
  mcpWrite: true,
  aiImage: true,
  aiVoice: true,
  aiStrongModel: true
} as const

// Committed values are the SELF-HOSTER DEFAULTS. Self-hosted instances
// run with billing off, so everyone is on `free`: the committed free
// tier therefore switches EVERY feature on and sets no member / history
// / MCP / web-tool limit. The hosted deployment narrows the free tier
// through `TIER_FREE_*` (rendered by `infra/render-env.sh` + `env.j2`). The hosted deployment
// can override any individual cap at runtime via `TIER_*` env vars
// (see `resolveTiersFromEnv` below) without a code change — e.g.
// `TIER_PRO_LITELLM_BUDGET_USD=8`. Server enforcement resolves through
// `server/utils/tierConfig.ts#getTiers()`; the client fetches the
// resolved map from `GET /api/billing/tiers`.
export const DEFAULT_TIERS = {
  free: {
    litellmBudgetUsd: 1, // 1000 AI Points
    workspacesOwned: 1,
    knowledgeFiles: 5,
    knowledgeBytesPerWorkspace: 50 * 1024 * 1024,
    knowledgeBytesPerUser: 50 * 1024 * 1024,
    imageBytesPerUser: 100 * 1024 * 1024,
    membersPerWorkspace: null,
    historyDays: null,
    savedThemes: 20,
    importMaxBytes: 50 * MB,
    webToolsPerDay: null,
    mcpToolCallsPerDay: null,
    customCss: true,
    mcpWrite: true,
    aiImage: true,
    aiVoice: true,
    aiStrongModel: true,
    sso: true,
    auditLog: true,
    guests: true,
    brandKit: true,
    shareControls: true,
    customDomains: true
  },
  pro: {
    litellmBudgetUsd: 5, // 5000 AI Points
    workspacesOwned: 100,
    knowledgeFiles: 100,
    knowledgeBytesPerWorkspace: 2 * 1024 * 1024 * 1024,
    knowledgeBytesPerUser: 2 * 1024 * 1024 * 1024,
    imageBytesPerUser: 2 * 1024 * 1024 * 1024,
    ...PAID_PLAN_ENTITLEMENTS,
    sso: true,
    auditLog: true,
    guests: true,
    brandKit: true,
    shareControls: true,
    customDomains: true
  },
  // Team / Business: AI budget, knowledge and image storage are per seat.
  // Team / Business: `litellmBudgetUsd`, `knowledgeFiles`,
  // `knowledgeBytesPerWorkspace` and `imageBytesPerUser` are PER SEAT;
  // a subscribed workspace pools seats × these values
  // (`server/utils/workspaceBilling.ts#workspacePoolCaps`).
  team: {
    litellmBudgetUsd: 5,
    workspacesOwned: 100,
    knowledgeFiles: 500,
    knowledgeBytesPerWorkspace: 5 * 1024 * 1024 * 1024,
    knowledgeBytesPerUser: 5 * 1024 * 1024 * 1024,
    imageBytesPerUser: 10 * 1024 * 1024 * 1024,
    ...PAID_PLAN_ENTITLEMENTS,
    sso: true,
    auditLog: true,
    guests: true,
    brandKit: true,
    shareControls: true,
    customDomains: true
  },
  business: {
    litellmBudgetUsd: 5,
    workspacesOwned: 100,
    knowledgeFiles: 2000,
    knowledgeBytesPerWorkspace: 20 * 1024 * 1024 * 1024,
    knowledgeBytesPerUser: 10 * 1024 * 1024 * 1024,
    imageBytesPerUser: 20 * 1024 * 1024 * 1024,
    ...PAID_PLAN_ENTITLEMENTS,
    sso: true,
    auditLog: true,
    guests: true,
    brandKit: true,
    shareControls: true,
    customDomains: true
  }
} as const satisfies Record<PlanName, TierCaps>

export const PLAN_NAMES: readonly PlanName[] = ['free', 'pro', 'team', 'business']

/** A fully-resolved tier map (defaults + any runtime overrides). */
export type TiersMap = Record<PlanName, TierCaps>

// Env-var suffix for each overridable cap field. Explicit table (no
// case-conversion magic) so the mapping is greppable in both directions.
const TIER_FIELD_ENV_SUFFIX: Record<keyof TierCaps, string> = {
  litellmBudgetUsd: 'LITELLM_BUDGET_USD',
  workspacesOwned: 'WORKSPACES_OWNED',
  knowledgeFiles: 'KNOWLEDGE_FILES',
  knowledgeBytesPerWorkspace: 'KNOWLEDGE_BYTES_PER_WORKSPACE',
  knowledgeBytesPerUser: 'KNOWLEDGE_BYTES_PER_USER',
  imageBytesPerUser: 'IMAGE_BYTES_PER_USER',
  membersPerWorkspace: 'MEMBERS_PER_WORKSPACE',
  historyDays: 'HISTORY_DAYS',
  savedThemes: 'SAVED_THEMES',
  importMaxBytes: 'IMPORT_MAX_BYTES',
  webToolsPerDay: 'WEB_TOOLS_PER_DAY',
  mcpToolCallsPerDay: 'MCP_TOOL_CALLS_PER_DAY',
  customCss: 'FEATURE_CUSTOM_CSS',
  mcpWrite: 'FEATURE_MCP_WRITE',
  aiImage: 'FEATURE_AI_IMAGE',
  aiVoice: 'FEATURE_AI_VOICE',
  aiStrongModel: 'FEATURE_AI_STRONG_MODEL',
  sso: 'FEATURE_SSO',
  auditLog: 'FEATURE_AUDIT_LOG',
  guests: 'FEATURE_GUESTS',
  brandKit: 'FEATURE_BRAND_KIT',
  shareControls: 'FEATURE_SHARE_CONTROLS',
  customDomains: 'FEATURE_CUSTOM_DOMAINS'
}

const BOOLEAN_TRUE = new Set(['1', 'true', 'yes', 'on'])
const BOOLEAN_FALSE = new Set(['0', 'false', 'no', 'off'])

/** Parse one override; `undefined` = keep the default. */
function parseOverride(field: keyof TierCaps, raw: string): number | boolean | null | undefined {
  const value = raw.trim().toLowerCase()
  if ((FEATURE_FIELDS as readonly string[]).includes(field)) {
    if (BOOLEAN_TRUE.has(value)) return true
    if (BOOLEAN_FALSE.has(value)) return false
    return undefined
  }
  if (value === 'unlimited' && (UNLIMITED_CAP_FIELDS as readonly string[]).includes(field)) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Resolve the effective tier map from an env-shaped record. Pure — no
 * process.env access — so every test tier can drive it directly.
 *
 * Override key shape: `TIER_<PLAN>_<FIELD>`, e.g.
 * `TIER_FREE_LITELLM_BUDGET_USD=2`, `TIER_ULTRA_KNOWLEDGE_FILES=5000`,
 * `TIER_FREE_MEMBERS_PER_WORKSPACE=unlimited`,
 * `TIER_FREE_FEATURE_CUSTOM_CSS=false`.
 * Numbers: only positive finite values; the fields in
 * `UNLIMITED_CAP_FIELDS` also accept `unlimited`. Feature switches:
 * `true|false|1|0|yes|no|on|off`. Anything else (absent, empty, NaN,
 * zero, negative) leaves the committed default in place — a typo'd
 * override must degrade to the default, never to a disabled product.
 */
export function resolveTiersFromEnv(
  env: Record<string, string | undefined>
): TiersMap {
  const resolved = {} as Record<PlanName, TierCaps>
  for (const plan of PLAN_NAMES) {
    const caps = { ...DEFAULT_TIERS[plan] } as TierCaps
    for (const field of Object.keys(TIER_FIELD_ENV_SUFFIX) as (keyof TierCaps)[]) {
      const raw = env[`TIER_${plan.toUpperCase()}_${TIER_FIELD_ENV_SUFFIX[field]}`]
      if (raw === undefined || raw.trim() === '') continue
      const value = parseOverride(field, raw)
      if (value !== undefined) (caps as unknown as Record<string, unknown>)[field] = value
    }
    resolved[plan] = caps
  }
  return resolved
}

/** The "more is better" cap fields — strictly higher on a bigger tier. */
export const MONOTONIC_CAP_FIELDS: readonly NumericCapField[] = [
  'litellmBudgetUsd',
  'workspacesOwned',
  'knowledgeFiles',
  'knowledgeBytesPerUser',
  'imageBytesPerUser'
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
  apiBase: '',
  successUrl: '/pricing?checkout=success&session={CHECKOUT_SESSION_ID}',
  cancelUrl: '/pricing?checkout=cancelled',
  // '1' enables Stripe Tax on Checkout Sessions (automatic_tax +
  // required billing address + VAT-id collection). OFF by default:
  // `automatic_tax` hard-errors unless Stripe Tax is activated and an
  // origin address is configured in the Stripe dashboard. Env:
  // NUXT_STRIPE_AUTOMATIC_TAX — flip it as a live-launch step.
  automaticTax: ''
} as const

export const STRIPE_CONFIG_KEYS = [
  'secretKey',
  'webhookSecret',
  'apiBase',
  'successUrl',
  'cancelUrl',
  'automaticTax'
] as const
