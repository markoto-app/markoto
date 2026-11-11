import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import {
  allStripePriceLookupKeys,
  parseStripePriceLookupKey,
  resolvePlanPricesFromEnv,
  stripePriceLookupKey,
  stripeTopupLookupKey,
  CURRENCIES,
  type BillingInterval,
  type Currency,
  type PaidPlanName,
  type PlanPriceTable,
  type PriceIdentity,
  type TopupPackId
} from '~~/shared/config/pricing'
import { MINUTE_MS } from '~~/shared/config/units'

// The Stripe price catalogue: which Stripe Price sells which
// plan / interval / currency.
//
// Prices are found by LOOKUP KEY (`markoto_pro_year_chf`, prefix
// `NUXT_STRIPE_LOOKUP_KEY_PREFIX`, default `markoto`), so the operator
// changes prices in the Stripe dashboard without a deploy. For setups
// without lookup keys (stripe-mock in the test stack, or an operator who
// prefers explicit ids) `NUXT_STRIPE_PRICE_IDS` maps keys to ids:
//   NUXT_STRIPE_PRICE_IDS=markoto_pro_month_eur=price_123,markoto_pro_year_eur=price_456
// An id listed there wins over the lookup key Stripe reports.
//
// The catalogue is cached in-process for 10 minutes. Reads process.env per
// call, like tierConfig.ts.

const CACHE_TTL_MS = 10 * MINUTE_MS
/** Stripe accepts at most 10 `lookup_keys` per list request. */
const LOOKUP_KEYS_PER_REQUEST = 10

export interface CatalogueEntry extends PriceIdentity {
  priceId: string
  /** Whole currency units, e.g. 9 for €9.00; null when unknown (id override). */
  amount: number | null
}

export interface StripeCatalogue {
  byKey: Map<string, CatalogueEntry>
  byPriceId: Map<string, CatalogueEntry>
}

let cache: { at: number, catalogue: StripeCatalogue } | null = null

export function lookupKeyPrefix(env: Record<string, string | undefined> = process.env): string {
  const raw = env.NUXT_STRIPE_LOOKUP_KEY_PREFIX?.trim()
  return raw && /^[a-z0-9-]+$/i.test(raw) ? raw : 'markoto'
}

/** Parse `NUXT_STRIPE_PRICE_IDS` (`key=price_id,…`) into key → id. Pure. */
export function parsePriceIdOverrides(raw: string | undefined, prefix: string): Map<string, PriceIdentity & { priceId: string }> {
  const out = new Map<string, PriceIdentity & { priceId: string }>()
  for (const pair of (raw ?? '').split(',')) {
    const [key, id] = pair.split('=').map(s => s?.trim())
    if (!key || !id) continue
    const identity = parseStripePriceLookupKey(key, prefix)
    if (!identity) continue
    out.set(key, { ...identity, priceId: id })
  }
  return out
}

/** Drop the cached catalogue (tests; after an operator changes prices). */
export function resetStripeCatalogueCache(): void {
  cache = null
}

export async function getStripeCatalogue(stripe: Stripe, now: number = Date.now()): Promise<StripeCatalogue> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.catalogue
  const prefix = lookupKeyPrefix()
  const byKey = new Map<string, CatalogueEntry>()
  const overrides = parsePriceIdOverrides(process.env.NUXT_STRIPE_PRICE_IDS, prefix)
  for (const [key, entry] of overrides) byKey.set(key, { ...entry, amount: null })

  const missing = allStripePriceLookupKeys(prefix).filter(key => !byKey.has(key))
  for (let i = 0; i < missing.length; i += LOOKUP_KEYS_PER_REQUEST) {
    const batch = missing.slice(i, i + LOOKUP_KEYS_PER_REQUEST)
    try {
      const list = await stripe.prices.list({ lookup_keys: batch, active: true, limit: 100 })
      for (const price of list.data) {
        const identity = parseStripePriceLookupKey(price.lookup_key, prefix)
        if (!identity || !price.lookup_key) continue
        byKey.set(price.lookup_key, {
          ...identity,
          priceId: price.id,
          amount: typeof price.unit_amount === 'number' ? price.unit_amount / 100 : null
        })
      }
    } catch (e) {
      console.warn('[stripe/prices] price lookup failed:', e instanceof Error ? e.message : e)
      Sentry.captureException(e, { tags: { component: 'stripePrices', event: 'lookup_failed' } })
    }
  }

  const byPriceId = new Map<string, CatalogueEntry>()
  for (const entry of byKey.values()) byPriceId.set(entry.priceId, entry)
  const catalogue = { byKey, byPriceId }
  cache = { at: now, catalogue }
  return catalogue
}

/** The Stripe Price id that sells this plan / interval / currency, or null. */
export async function stripePriceIdFor(stripe: Stripe, plan: PaidPlanName, interval: BillingInterval, currency: Currency): Promise<string | null> {
  const catalogue = await getStripeCatalogue(stripe)
  return catalogue.byKey.get(stripePriceLookupKey(plan, interval, currency, lookupKeyPrefix()))?.priceId ?? null
}

/**
 * What a Stripe Price sells. The id overrides come first, then the
 * price's own lookup key (present on webhook payloads), then the cached
 * catalogue. `null` = not one of our prices (logged + skipped by callers).
 */
export async function identifyStripePrice(
  stripe: Stripe | null,
  price: { id?: string | null, lookup_key?: string | null } | null | undefined
): Promise<PriceIdentity | null> {
  if (!price) return null
  const prefix = lookupKeyPrefix()
  const overrides = parsePriceIdOverrides(process.env.NUXT_STRIPE_PRICE_IDS, prefix)
  for (const entry of overrides.values()) {
    if (entry.priceId === price.id) return { plan: entry.plan, interval: entry.interval, currency: entry.currency }
  }
  const fromKey = parseStripePriceLookupKey(price.lookup_key, prefix)
  if (fromKey) return fromKey
  if (stripe && price.id) {
    const entry = (await getStripeCatalogue(stripe)).byPriceId.get(price.id)
    if (entry) return { plan: entry.plan, interval: entry.interval, currency: entry.currency }
  }
  return null
}

/**
 * The live price table for /pricing: Stripe's amounts where known, the
 * configured planned amounts as the fallback for any price without one
 * (an id override, or a key the operator hasn't created yet).
 */
export async function livePlanPriceTable(stripe: Stripe): Promise<PlanPriceTable> {
  const table = resolvePlanPricesFromEnv(process.env)
  const catalogue = await getStripeCatalogue(stripe)
  for (const entry of catalogue.byKey.values()) {
    if (entry.amount !== null && (CURRENCIES as readonly string[]).includes(entry.currency)) {
      table[entry.currency][entry.plan][entry.interval] = entry.amount
    }
  }
  return table
}

const topupCache = new Map<string, { at: number, priceId: string | null }>()

/**
 * The one-time Stripe Price that sells a top-up pack in a currency:
 * `NUXT_STRIPE_PRICE_IDS` (`markoto_topup_10_eur=price_…`) first, else
 * the lookup key. Cached 10 minutes; null = not set up.
 */
export async function stripeTopupPriceIdFor(stripe: Stripe, pack: TopupPackId, currency: Currency, now: number = Date.now()): Promise<string | null> {
  const prefix = lookupKeyPrefix()
  const key = stripeTopupLookupKey(pack, currency, prefix)
  for (const pair of (process.env.NUXT_STRIPE_PRICE_IDS ?? '').split(',')) {
    const [k, id] = pair.split('=').map(s => s?.trim())
    if (k === key && id) return id
  }
  const cached = topupCache.get(key)
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.priceId
  let priceId: string | null = null
  try {
    const list = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 })
    priceId = list.data[0]?.id ?? null
  } catch (e) {
    console.warn('[stripe/prices] top-up price lookup failed:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, { tags: { component: 'stripePrices', event: 'topup_lookup_failed' } })
  }
  topupCache.set(key, { at: now, priceId })
  return priceId
}
