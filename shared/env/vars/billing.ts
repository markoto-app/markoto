import { bool, csv, pattern, positiveNumber, string, url } from '../coerce'
import { defineNamespace, v, type AnyVar } from '../define'
import { DEFAULT_TIERS, PLAN_NAMES, TIER_FIELDS, tierEnvName, tierOverrideType } from '../../config/tiers'
import { BILLING_INTERVALS, CURRENCIES, DEFAULT_PLAN_PRICES, PAID_PLAN_NAMES, planPriceEnvName } from '../../config/pricing'
import { SALES_REGION_PATTERN } from '../../config/salesRegions'

const salesRegions = csv(pattern(SALES_REGION_PATTERN, 'a country code (DE) or a subdivision (US-CA)'))

export const billing = defineNamespace({
  name: 'billing',
  title: 'Billing',
  intro: 'One codebase, three shapes: self-host (both off), hosted free-only (coming soon on), paid plans live (billing on → Stripe required in production).',
  vars: {
    enabled: v({
      name: 'NUXT_BILLING_ENABLED',
      example: 'false',
      type: bool,
      default: false,
      doc: 'Stripe checkout / portal / webhooks and paid tiers are live. Off = everyone on the free tier, billing endpoints 404.',
      services: ['app'],
      scope: 'both'
    }),
    plansComingSoon: v({
      name: 'NUXT_PLANS_COMING_SOON',
      example: 'false',
      type: bool,
      default: false,
      doc: 'With billing off: show paid plans as "coming soon" + the waitlist (hosted free-only SaaS).',
      services: ['app'],
      scope: 'hosted'
    }),
    stripeSecretKey: v({
      name: 'NUXT_STRIPE_SECRET_KEY',
      example: '',
      type: string,
      secret: true,
      doc: 'Stripe secret key.',
      services: ['app'],
      scope: 'hosted',
      required: { when: 'NUXT_BILLING_ENABLED=true and NODE_ENV=production' }
    }),
    stripeWebhookSecret: v({
      name: 'NUXT_STRIPE_WEBHOOK_SECRET',
      example: '',
      type: string,
      secret: true,
      doc: 'Stripe webhook signing secret.',
      services: ['app'],
      scope: 'hosted',
      required: { when: 'NUXT_BILLING_ENABLED=true and NODE_ENV=production' }
    }),
    stripeApiBase: v({
      name: 'NUXT_STRIPE_API_BASE',
      type: url(),
      doc: 'Override the Stripe API base (stripe-mock in tests).',
      services: ['app'],
      scope: 'test',
      notPassed: 'test stacks only'
    }),
    stripeLookupKeyPrefix: v({
      name: 'NUXT_STRIPE_LOOKUP_KEY_PREFIX',
      type: pattern(/^[a-z0-9-]+$/i, 'letters, digits and "-" only'),
      default: 'markoto',
      doc: 'Prefix of the Stripe price lookup keys (<prefix>_<plan>_<month|year>_<eur|chf>).',
      services: ['app'],
      scope: 'hosted'
    }),
    stripePriceIds: v({
      name: 'NUXT_STRIPE_PRICE_IDS',
      type: string,
      default: '',
      doc: 'Explicit `lookup_key=price_id` pairs, comma-separated, for setups without lookup keys.',
      services: ['app'],
      scope: 'hosted'
    }),
    stripeAutomaticTax: v({
      name: 'NUXT_STRIPE_AUTOMATIC_TAX',
      type: bool,
      default: false,
      doc: 'Stripe Tax on checkout (only after activating Stripe Tax in the dashboard).',
      services: ['app'],
      scope: 'hosted'
    }),
    b2cAllowedCountries: v({
      name: 'NUXT_BILLING_B2C_ALLOWED_COUNTRIES',
      type: salesRegions,
      default: [],
      doc: 'With automatic tax on: billing countries (DE) or subdivisions (US-CA) where consumers without a tax ID may buy. Empty = everywhere. List in shared/config/salesRegions.ts.',
      services: ['app'],
      scope: 'hosted'
    }),
    b2bAllowedCountries: v({
      name: 'NUXT_BILLING_B2B_ALLOWED_COUNTRIES',
      type: salesRegions,
      default: [],
      doc: 'With automatic tax on: billing countries or subdivisions where companies with a tax ID may buy. Empty = everywhere.',
      services: ['app'],
      scope: 'hosted'
    }),
    blockedCountries: v({
      name: 'NUXT_BILLING_BLOCKED_COUNTRIES',
      type: salesRegions,
      default: [],
      doc: 'With automatic tax on: billing countries or subdivisions where nobody may buy, on top of both allow lists.',
      services: ['app'],
      scope: 'hosted'
    }),
    stripeSuccessUrl: v({
      name: 'NUXT_STRIPE_SUCCESS_URL',
      type: string,
      default: '/pricing?checkout=success&session={CHECKOUT_SESSION_ID}',
      doc: 'Path Stripe returns to after a successful checkout.',
      services: ['app'],
      scope: 'hosted',
      notPassed: 'the default is the app\'s own page'
    }),
    stripeCancelUrl: v({
      name: 'NUXT_STRIPE_CANCEL_URL',
      type: string,
      default: '/pricing?checkout=cancelled',
      doc: 'Path Stripe returns to after a cancelled checkout.',
      services: ['app'],
      scope: 'hosted',
      notPassed: 'the default is the app\'s own page'
    })
  }
})

// Hosted-SaaS narrowing of the free tier and the few paid-tier switches
// render-env.sh sets; the remaining overrides are documented but not
// passed by the compose files (set them in a custom compose override).
const PASSED_TIER_OVERRIDES = new Set([
  ...TIER_FIELDS.map(f => tierEnvName('free', f)),
  'TIER_PRO_FEATURE_SSO', 'TIER_PRO_FEATURE_AUDIT_LOG', 'TIER_PRO_FEATURE_GUESTS', 'TIER_PRO_FEATURE_BRAND_KIT',
  'TIER_TEAM_FEATURE_SSO', 'TIER_TEAM_FEATURE_AUDIT_LOG'
])

function tierVars(): Record<string, AnyVar> {
  return { ...tierLimitVars(), ...plannedPriceVars() }
}

/** TIER_<PLAN>_<FIELD>: every plan limit and feature switch. */
function tierLimitVars(): Record<string, AnyVar> {
  const vars: Record<string, AnyVar> = {}
  for (const plan of PLAN_NAMES) {
    for (const field of TIER_FIELDS) {
      const name = tierEnvName(plan, field)
      const committed = DEFAULT_TIERS[plan][field]
      vars[name] = v({
        name,
        type: tierOverrideType(field),
        // Unset = the committed value; the registry has no default of its
        // own so the tier table stays the single source.
        defaultDoc: committed === null ? 'no limit' : `\`${String(committed)}\``,
        doc: `${plan} plan: ${field} (committed default in shared/config/tiers.ts).`,
        services: ['app'],
        scope: plan === 'free' ? 'both' : 'hosted',
        ...(PASSED_TIER_OVERRIDES.has(name) ? {} : { notPassed: 'documented override; add it to your compose override to use it' })
      })
    }
  }
  return vars
}

/** TIER_<PLAN>_PRICE_<CURRENCY>[_YEAR]: the planned prices shown while billing is off. */
function plannedPriceVars(): Record<string, AnyVar> {
  const vars: Record<string, AnyVar> = {}
  for (const plan of PAID_PLAN_NAMES) {
    for (const currency of CURRENCIES) {
      for (const interval of BILLING_INTERVALS) {
        const name = planPriceEnvName(plan, currency, interval)
        vars[name] = v({
          name,
          type: positiveNumber,
          defaultDoc: `\`${DEFAULT_PLAN_PRICES[currency][plan][interval]}\``,
          doc: `Planned ${plan} price per ${interval} in ${currency.toUpperCase()} shown while billing is off (shared/config/pricing.ts).`,
          services: ['app'],
          scope: 'hosted',
          notPassed: 'planned prices; the committed defaults are the hosted ones'
        })
      }
    }
  }
  return vars
}

export const tiers = defineNamespace({
  name: 'tiers',
  title: 'Plan limits and feature switches',
  intro: 'TIER_<FREE|PRO|TEAM|BUSINESS>_<FIELD>. Numbers > 0, `unlimited` for the per-day / member / history limits, booleans for FEATURE_*. With billing off everyone is on FREE, so TIER_FREE_* are every account\'s limits.',
  vars: tierVars()
})
