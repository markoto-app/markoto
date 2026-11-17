<script setup lang="ts">
import { useInvalidatePlan, usePlanPricesQuery, useTierLimitsQuery } from '~/queries/billing'
import { DEFAULT_TIERS, PLAN_NAMES, type PlanName } from '~~/shared/config/tiers'
import {
  CURRENCIES,
  DEFAULT_PLAN_PRICES,
  PAID_PLAN_NAMES,
  TOPUP_PACKS,
  TOPUP_VALIDITY_MONTHS,
  defaultCurrencyForLocale,
  isPerSeatPlan,
  type BillingInterval,
  type Currency,
  type PaidPlanName
} from '~~/shared/config/pricing'
import { pricingStructuredData, type FaqItem, type PricingOffer } from '~~/shared/seo/structuredData'
import { pageBreadcrumbs } from '~~/shared/seo/breadcrumbs'
import { MAX_WORKSPACE_SEATS, MIN_WORKSPACE_SEATS } from '~~/shared/config/workspaceSeats'

// Pricing page.
//
// Every number is live config: tier caps from `GET /api/billing/tiers`
// (committed defaults + TIER_* overrides, `getTiers()`), prices from
// `GET /api/billing/prices` (live Stripe prices, or the planned ones in
// `shared/config/pricing.ts` + TIER_*_PRICE_<EUR|CHF>[_YEAR]),
// the anonymous-document retention from the instance config
// (`NUXT_INACTIVE_DOC_TTL_DAYS`). The committed defaults are the
// SSR/fetch-failure fallback.
//
// Two layouts, three instance shapes (shared/config/billingMode.ts):
//   - Plans (billing ON, or billing OFF + NUXT_PLANS_COMING_SOON on the
//     hosted site): one billing-period switch and one currency select,
//     three cards, Free / Pro / Teams (a Team · Business switch with a seat
//     stepper), one line on extra AI Points, one line to write without an
//     account or self-host, the comparison table behind a disclosure, and
//     an FAQ.
//       · billing on: real prices + Stripe Checkout / Customer Portal CTAs.
//       · coming soon: PLANNED prices, labelled as planned, no purchase
//         button; one slim waitlist bar above the cards, which the paid
//         cards' buttons lead to.
//   - Instance limits (billing OFF without coming soon = self-hosted):
//     one card with the limits every account on this instance gets.

// Shared site header + footer. Not hosted-only: self-hosted instances
// show their limits here too (`pricingVisible` decides who links to it).
definePageMeta({ layout: 'marketing' })

const { t, locale, localeProperties } = useI18n()
const { loggedIn } = useUserSession()
// Login starts at the first configured OAuth provider (null when none).
const { primaryLoginPath, anonDocTtlDays, marketingSite, siteUrl } = useInstanceConfig()
const { billingEnabled, plansComingSoon } = useBillingMode()

// Shared queries: fetched during the server render (cookies forwarded) and
// hydrated from the payload; awaited so a client-side navigation shows the
// real numbers on first paint, as `await useFetch` did.
const tiersQuery = useTierLimitsQuery()
const pricesQuery = usePlanPricesQuery()
await Promise.all([tiersQuery.refresh(), pricesQuery.refresh()])
const TIERS = computed(() => tiersQuery.data.value ?? DEFAULT_TIERS)
const PRICE_TABLE = computed(() => pricesQuery.data.value?.prices ?? DEFAULT_PLAN_PRICES)

// Currency + billing interval the visitor looks at. EUR on the server
// render; after mount a Swiss browser locale (de-CH, fr-CH, …) switches
// to CHF. Both are switchable on the page.
const currency = ref<Currency>('eur')
const interval = ref<BillingInterval>('month')
const CURRENCY = computed(() => currency.value.toUpperCase())
/** Prices in the selected currency + interval (free = 0). */
const PRICES = computed<Record<PlanName, number>>(() => {
  const row = PRICE_TABLE.value[currency.value]
  return { free: 0, pro: row.pro[interval.value], team: row.team[interval.value], business: row.business[interval.value] }
})
/** Monthly prices in the selected currency (comparison table). */
const MONTHLY_PRICES = computed<Record<PlanName, number>>(() => {
  const row = PRICE_TABLE.value[currency.value]
  return { free: 0, pro: row.pro.month, team: row.team.month, business: row.business.month }
})
const currencyItems = CURRENCIES.map(c => ({ label: c.toUpperCase(), value: c }))
const intervalItems = computed(() => [
  { label: t('pricing.interval.month'), value: 'month' as const },
  { label: t('pricing.interval.year'), value: 'year' as const }
])
// Team / Business: a seat count for the total (minimum 3, the smallest
// workspace subscription).
const seats = ref(MIN_WORKSPACE_SEATS)
function seatTotal(plan: PlanName): string {
  const total = PRICES.value[plan] * seats.value
  return t(interval.value === 'year' ? 'pricing.seatTotalYear' : 'pricing.seatTotalMonth', {
    total: formatPrice(total, CURRENCY.value, locale.value),
    seats: seats.value
  })
}

function priceUnitKey(plan: PlanName): string {
  if (isPerSeatPlan(plan)) return interval.value === 'year' ? 'pricing.price.perSeatPerYear' : 'pricing.price.perSeatPerMonth'
  return interval.value === 'year' ? 'pricing.price.perYear' : 'pricing.price.perMonth'
}

// The caller's plan (shared with the topbar badge), for the "current plan"
// highlight. Signed out or failed: no highlight.
const { billing, refresh: refreshBilling } = useBilling()
const invalidatePlan = useInvalidatePlan()

const optionsLayout = computed(() => billingEnabled.value || plansComingSoon.value)
/** Paid prices are planned, not on sale. */
const pricesPlanned = computed(() => !billingEnabled.value)

const PAID_TAGLINE: Record<PaidPlanName, string> = {
  pro: 'pricing.tiers.pro',
  team: 'pricing.tiers.team',
  business: 'pricing.tiers.business'
}
const PAID_DISPLAY: Record<PaidPlanName, string> = { pro: 'Pro', team: 'Team', business: 'Business' }

function paidPlanFor(value: string | number | undefined): PaidPlanName | undefined {
  return PAID_PLAN_NAMES.find(plan => plan === value)
}

// The Teams card: Team or Business, the same seat stepper for both.
type TeamPlanName = 'team' | 'business'
const teamPlan = ref<TeamPlanName>('team')
const teamPlanItems = [
  { label: PAID_DISPLAY.team, value: 'team' as const },
  { label: PAID_DISPLAY.business, value: 'business' as const }
]
// Show Business on the Teams card when the caller is on it.
watch(() => billing.value?.plan, (plan) => {
  if (plan === 'team' || plan === 'business') teamPlan.value = plan
}, { immediate: true })

onMounted(() => {
  currency.value = defaultCurrencyForLocale(globalThis.navigator?.language)
  // The page always read the plan fresh; a snapshot loaded earlier by the
  // topbar is re-read (a first load is already under way otherwise).
  if (billing.value) void refreshBilling()
})

const pageTitle = computed(() =>
  optionsLayout.value ? t('pricing.title') : t('pricing.selfHostedTitle')
)
const pageSubtitle = computed(() => {
  if (billingEnabled.value) return t('pricing.subtitle')
  return plansComingSoon.value ? t('pricing.comingSoonSubtitle') : t('pricing.selfHostedSubtitle')
})

function price(plan: PlanName): string {
  return formatPrice(PRICES.value[plan], CURRENCY.value, locale.value)
}

/** The line under a price: planned (coming soon) or on sale now. */
function priceNote(plan: PlanName): string {
  return pricesPlanned.value && plan !== 'free' ? t('pricing.price.planned') : t('pricing.availableNow')
}

// Coming soon: the paid cards' button leads to the waitlist bar above the
// cards and puts the cursor into its email field.
function focusWaitlist(): void {
  const bar = document.getElementById('waitlist')
  if (!bar) return
  const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  bar.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' })
  bar.querySelector<HTMLInputElement>('input[type="email"]')?.focus({ preventScroll: true })
}

// The comparison table is folded away until asked for.
const compareOpen = ref(false)

function isCurrent(plan: PlanName): boolean {
  return billing.value?.plan === plan
}

/**
 * The price on screen is the one the subscription pays: same plan AND the
 * billing period of the selected tab. The "current plan" badge follows
 * this; the CTA follows the plan alone (`isCurrent`).
 */
function isCurrentPrice(plan: PlanName): boolean {
  if (!isCurrent(plan)) return false
  const mine = billing.value?.interval ?? null
  return mine === null || mine === interval.value
}

// Personal tier ranking. Drives the "upgrade vs downgrade" CTA split.
// Team / Business are workspace plans with their own CTA (`isPerSeatPlan`).
const PLAN_ORDER: readonly PlanName[] = PLAN_NAMES
type CtaKind = 'current' | 'upgrade' | 'downgrade' | 'signup' | 'free-stay'

function ctaKind(plan: PlanName): CtaKind {
  if (isCurrent(plan)) return 'current'
  if (!loggedIn.value) {
    return plan === 'free' ? 'free-stay' : 'signup'
  }
  const mine = PLAN_ORDER.indexOf(billing.value?.plan ?? 'free')
  const theirs = PLAN_ORDER.indexOf(plan)
  return theirs > mine ? 'upgrade' : 'downgrade'
}

const toast = useToast()
const { extractError } = useErrorHandler()
const checkoutLoading = ref<PlanName | null>(null)
// The Paid Plans Terms box: required for every purchase.
const paidTermsAccepted = ref(false)

async function onChangePlan(plan: PlanName): Promise<void> {
  if (!billingEnabled.value) return
  if (!loggedIn.value) {
    globalThis.location.href = primaryLoginPath.value ?? '/'
    return
  }
  if (plan === 'free' || checkoutLoading.value) return
  if (ctaKind(plan) !== 'downgrade' && !paidTermsAccepted.value) return

  const kind = ctaKind(plan)
  if (kind === 'downgrade') {
    // Downgrade routes through the Customer Portal. Stripe handles
    // the actual plan change + proration + retention UI there. Users
    // can also cancel, pause, update card from the same page.
    await openPortal()
    return
  }

  // Upgrade path. The server decides the mechanics: a first-time
  // subscriber gets a Checkout URL to redirect to; a user with a live
  // subscription gets an IN-PLACE price swap on that subscription
  // (prorated, charged immediately) and `{ updated: true }` back,
  // never a second concurrent subscription.
  checkoutLoading.value = plan
  try {
    const resp = await apiFetch('/api/billing/checkout', {
      method: 'post',
      body: { plan, interval: interval.value, currency: currency.value, acceptPaidTerms: true }
    })
    if ('updated' in resp) {
      toast.add({
        title: t('billing.planUpdated.title'),
        description: t('billing.planUpdated.description', { plan: PAID_DISPLAY[resp.plan] }),
        icon: 'i-lucide-check-circle',
        color: 'success'
      })
      checkoutLoading.value = null
      // The plan, its limits and the AI budgets changed, for this page's
      // highlight and for the topbar badge alike. The webhook that flips
      // the plan can lag the API response by a beat: re-read once now and
      // once shortly after so everything settles on the new state.
      await invalidatePlan()
      setTimeout(() => {
        void invalidatePlan()
      }, 2500)
      return
    }
    // Full-page redirect: Stripe's hosted Checkout is a separate
    // origin, can't be iframed.
    if (resp.url) globalThis.location.href = resp.url
  } catch (e) {
    toast.add({
      title: t('workspace.billing.checkoutFailed'),
      description: extractError(e).message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
    checkoutLoading.value = null
  }
}

const portalLoading = ref(false)
async function openPortal(): Promise<void> {
  if (!billingEnabled.value || portalLoading.value) return
  portalLoading.value = true
  try {
    const { url } = await apiFetch('/api/billing/portal', {
      method: 'post'
    })
    globalThis.location.href = url
  } catch (e) {
    toast.add({
      title: t('settings.profile.spending.portalFailed'),
      description: extractError(e).message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    portalLoading.value = false
  }
}

const faqItems = computed<FaqItem[]>(() => {
  const items: FaqItem[] = []
  if (plansComingSoon.value) {
    items.push({ q: t('pricing.faq.comingSoonQ'), a: t('pricing.faq.comingSoonA') })
  }
  items.push({
    q: t('pricing.faq.byokQ'),
    a: plansComingSoon.value ? `${t('pricing.faq.byokA')} ${t('pricing.freeAllowanceNote')}` : t('pricing.faq.byokA')
  })
  // Extra AI Points: the packs with their points, then how they are used.
  const packs = TOPUP_PACKS.map(pack => t('credits.pack', {
    price: formatPrice(pack.price[currency.value], CURRENCY.value, locale.value),
    points: formatAiPoints(pack.creditUsd, locale.value)
  })).join(' · ')
  items.push({
    q: t('pricing.faq.pointsQ'),
    a: `${t('pricing.creditsHint')} ${t('pricing.faq.pointsPacks', { packs })} ${t('credits.explainer', { months: TOPUP_VALIDITY_MONTHS })}`
  })
  // The EU data path is a statement about markoto.app's own providers,
  // only true on the hosted site.
  if (marketingSite.value) {
    items.push({ q: t('pricing.faq.euQ'), a: t('pricing.faq.euA') })
  }
  items.push({
    q: t('pricing.faq.anonQ'),
    a: anonDocTtlDays.value > 0
      ? t('pricing.faq.anonA', { n: formatCount(anonDocTtlDays.value, locale.value) }, anonDocTtlDays.value)
      : t('pricing.faq.anonKeptA')
  })
  items.push({ q: t('pricing.faq.selfHostQ'), a: t('pricing.faq.selfHostA') })
  return items
})

// Meta description: the hosted free-only + self-hosted subtitles are short
// enough; with billing on, a dedicated one (the subtitle runs long).
const metaDescription = computed(() => (billingEnabled.value ? t('pricing.metaDescription') : pageSubtitle.value))
const { imageUrl } = useMarketingSeo({
  title: pageTitle,
  description: () => metaDescription.value,
  imageGroup: 'pricing'
})

// SoftwareApplication + Offer JSON-LD, marketing site only (like the
// home page's). Offers are what someone can take up TODAY: the free
// account always; Pro / Team / Business only while billing is on. Planned
// prices are on the page, labelled as planned, but an Offer states a
// price someone can pay, publishing one for a plan nobody can buy
// would put a wrong claim into search results.
// One graph with the page's WebPage + BreadcrumbList (usePageStructuredData
// is marketing-site only too).
/** One offer per plan, billing period and currency someone can pay. */
function paidOffers(): PricingOffer[] {
  return PAID_PLAN_NAMES.flatMap(plan => CURRENCIES.flatMap(cur => (['month', 'year'] as const).map(iv => ({
    name: `${PAID_DISPLAY[plan]} (${iv === 'year' ? t('pricing.interval.year') : t('pricing.interval.month')}, ${cur.toUpperCase()})`,
    price: PRICE_TABLE.value[cur][plan][iv],
    currency: cur.toUpperCase(),
    interval: iv,
    perSeat: isPerSeatPlan(plan)
  }))))
}
usePageStructuredData(() => {
  if (!optionsLayout.value) return null
  const offers: PricingOffer[] = [{ name: t('pricing.plans.free'), price: 0 }, ...(billingEnabled.value ? paidOffers() : [])]
  return {
    name: pageTitle.value,
    description: metaDescription.value,
    image: imageUrl.value,
    breadcrumbs: pageBreadcrumbs('/pricing', pageTitle.value),
    about: [{ self: true }],
    extraNodes: [pricingStructuredData({
      siteUrl: siteUrl.value,
      description: metaDescription.value,
      inLanguage: localeProperties.value.language ?? locale.value,
      currency: 'EUR',
      offers
    })]
  }
})
</script>

<template>
  <div>
    <!-- Header + footer come from the `marketing` layout. -->
    <div class="max-w-6xl mx-auto px-4 py-8 sm:py-12">
      <div class="text-center mb-8 sm:mb-10">
        <h1 class="font-serif text-3xl sm:text-5xl font-light tracking-tight">
          {{ pageTitle }}
        </h1>
        <p
          class="mt-3 text-sm sm:text-base text-muted max-w-2xl mx-auto"
          data-testid="pricing-subtitle"
        >
          {{ pageSubtitle }}
        </p>
        <div
          v-if="optionsLayout"
          class="mt-6 flex flex-wrap items-center justify-center gap-3"
        >
          <UTabs
            v-model="interval"
            :items="intervalItems"
            :content="false"
            color="neutral"
            variant="pill"
            size="sm"
            :aria-label="t('pricing.interval.label')"
            data-testid="pricing-interval"
          />
          <USelect
            v-model="currency"
            :items="currencyItems"
            size="sm"
            class="w-24"
            :aria-label="t('pricing.currencyLabel')"
            data-testid="pricing-currency"
          />
        </div>
      </div>

      <!-- ═══ Plans (hosted site / billing on) ═══ -->
      <template v-if="optionsLayout">
        <!-- Paid-plans waitlist (hosted free-only SaaS only). -->
        <div
          v-if="plansComingSoon"
          id="waitlist"
          class="scroll-mt-24 mb-8"
        >
          <PricingWaitlistForm />
        </div>

        <div
          class="grid gap-6 lg:gap-4 lg:grid-cols-3 max-w-xl mx-auto lg:max-w-none"
          data-testid="pricing-options"
        >
          <!-- Free -->
          <PricingPlanCard
            :title="t('pricing.plans.free')"
            :tagline="t('pricing.tiers.free')"
            :price="price('free')"
            :unit="t(priceUnitKey('free'))"
            :price-note="priceNote('free')"
            :current="isCurrent('free')"
            :coming-soon="false"
            data-testid="pricing-tier-free"
            :data-current="isCurrent('free')"
            data-coming-soon="false"
          >
            <PricingPlanHighlights
              plan="free"
              :tiers="TIERS"
            />
            <template #cta>
              <UButton
                v-if="isCurrent('free')"
                disabled
                block
                color="neutral"
                variant="subtle"
              >
                {{ t('pricing.currentPlan') }}
              </UButton>
              <UButton
                v-else-if="billingEnabled && !!paidPlanFor(billing?.plan)"
                block
                color="neutral"
                variant="outline"
                :loading="portalLoading"
                @click="openPortal"
              >
                {{ t('pricing.downgrade') }}
              </UButton>
              <UButton
                v-else-if="!loggedIn && primaryLoginPath"
                :to="primaryLoginPath"
                external
                block
                color="neutral"
                variant="outline"
                data-testid="pricing-free-sign-in"
              >
                {{ t('pricing.freeAccount.signIn') }}
              </UButton>
            </template>
          </PricingPlanCard>

          <!-- Pro -->
          <PricingPlanCard
            :title="PAID_DISPLAY.pro"
            :tagline="t(PAID_TAGLINE.pro)"
            :price="price('pro')"
            :unit="t(priceUnitKey('pro'))"
            :price-note="priceNote('pro')"
            :current="isCurrentPrice('pro')"
            :coming-soon="pricesPlanned"
            data-testid="pricing-tier-pro"
            :data-current="isCurrent('pro')"
            :data-coming-soon="pricesPlanned"
          >
            <PricingPlanHighlights
              plan="pro"
              :tiers="TIERS"
            />
            <template #cta>
              <!-- Coming soon: nothing to buy, the waitlist is above. -->
              <UButton
                v-if="pricesPlanned"
                block
                color="neutral"
                variant="outline"
                data-testid="pricing-join-waitlist"
                @click="focusWaitlist"
              >
                {{ t('pricing.paid.joinWaitlist') }}
              </UButton>
              <!-- Billing on: current → Customer Portal; higher →
                   upgrade (Checkout or in-place swap); lower → portal
                   downgrade; logged out → sign up. -->
              <UButton
                v-else-if="ctaKind('pro') === 'current'"
                block
                color="neutral"
                variant="outline"
                icon="i-lucide-external-link"
                :loading="portalLoading"
                @click="openPortal"
              >
                {{ t('pricing.manageSubscription') }}
              </UButton>
              <UButton
                v-else-if="ctaKind('pro') === 'downgrade'"
                block
                color="neutral"
                variant="outline"
                :loading="portalLoading"
                @click="onChangePlan('pro')"
              >
                {{ t('pricing.downgrade') }}
              </UButton>
              <template v-else>
                <PricingPaidTermsConsent
                  v-if="loggedIn"
                  v-model="paidTermsAccepted"
                  kind="plan"
                  size="xs"
                  class="mb-3"
                  testid="pricing-paid-terms-pro"
                />
                <UButton
                  block
                  color="neutral"
                  :disabled="loggedIn && !paidTermsAccepted"
                  :loading="checkoutLoading === 'pro'"
                  data-testid="pricing-buy-pro"
                  @click="onChangePlan('pro')"
                >
                  {{ loggedIn ? t('pricing.upgrade') : t('pricing.signUp') }}
                </UButton>
              </template>
            </template>
          </PricingPlanCard>

          <!-- Teams: Team or Business, per seat -->
          <div
            class="grid"
            data-testid="pricing-option-teams"
          >
            <PricingPlanCard
              :title="t('pricing.teams.title')"
              :tagline="t(PAID_TAGLINE[teamPlan])"
              :price="price(teamPlan)"
              :unit="t(priceUnitKey(teamPlan))"
              :price-note="priceNote(teamPlan)"
              :current="isCurrentPrice(teamPlan)"
              :coming-soon="pricesPlanned"
              :data-testid="`pricing-tier-${teamPlan}`"
              :data-current="isCurrent(teamPlan)"
              :data-coming-soon="pricesPlanned"
            >
              <template #switch>
                <UTabs
                  v-model="teamPlan"
                  :items="teamPlanItems"
                  :content="false"
                  color="neutral"
                  variant="pill"
                  size="xs"
                  :aria-label="t('pricing.teams.switchLabel')"
                  data-testid="pricing-teams-switch"
                />
              </template>
              <template #price-extra>
                <div class="mt-3 flex items-center gap-2 flex-wrap">
                  <UInputNumber
                    v-model="seats"
                    :min="MIN_WORKSPACE_SEATS"
                    :max="MAX_WORKSPACE_SEATS"
                    size="xs"
                    class="w-28"
                    :aria-label="t('pricing.seatsLabel')"
                    :data-testid="`pricing-seats-${teamPlan}`"
                  />
                  <span
                    class="text-sm text-muted"
                    :data-testid="`pricing-seat-total-${teamPlan}`"
                  >{{ seatTotal(teamPlan) }}</span>
                </div>
              </template>
              <PricingPlanHighlights
                :plan="teamPlan"
                :tiers="TIERS"
              />
              <template #cta>
                <UButton
                  v-if="pricesPlanned"
                  block
                  color="neutral"
                  variant="outline"
                  data-testid="pricing-join-waitlist"
                  @click="focusWaitlist"
                >
                  {{ t('pricing.paid.joinWaitlist') }}
                </UButton>
                <!-- Team / Business are bought for a workspace, from its
                     billing settings. -->
                <template v-else>
                  <p class="mb-3 text-xs text-muted">
                    {{ t('pricing.paid.setUpInWorkspaceHint') }}
                  </p>
                  <UButton
                    to="/"
                    block
                    color="neutral"
                    variant="outline"
                    :data-testid="`pricing-workspace-plan-${teamPlan}`"
                  >
                    {{ t('pricing.paid.setUpInWorkspace') }}
                  </UButton>
                </template>
              </template>
            </PricingPlanCard>
          </div>
        </div>

        <p
          v-if="pricesPlanned"
          class="mt-4 text-center text-xs text-muted"
          data-testid="pricing-planned-note"
        >
          {{ t('pricing.price.plannedNote') }}
        </p>

        <PricingMoreOptions
          class="mt-8"
          :currency="currency"
          :planned="pricesPlanned"
          :can-buy="billingEnabled && billing?.plan === 'pro'"
        />

        <!-- Comparison table, folded away. The table is in the server
             render either way; it hydrates when opened. -->
        <section
          class="mt-12 sm:mt-16"
          data-testid="pricing-compare"
          aria-labelledby="pricing-compare-title"
        >
          <h2
            id="pricing-compare-title"
            class="text-center"
          >
            <UButton
              color="neutral"
              variant="outline"
              :trailing-icon="compareOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              :aria-expanded="compareOpen"
              aria-controls="pricing-compare-panel"
              data-testid="pricing-compare-toggle"
              @click="compareOpen = !compareOpen"
            >
              {{ t('pricing.compare.title') }}
            </UButton>
          </h2>
          <div
            v-show="compareOpen"
            id="pricing-compare-panel"
            class="mt-4"
          >
            <LazyPricingCompareTable
              hydrate-on-visible
              :tiers="TIERS"
              :prices="MONTHLY_PRICES"
              :currency="CURRENCY"
              :planned="pricesPlanned"
            />
          </div>
        </section>

        <section
          class="mt-12 sm:mt-16 max-w-3xl mx-auto"
          aria-labelledby="pricing-faq-title"
        >
          <h2
            id="pricing-faq-title"
            class="font-serif text-2xl sm:text-3xl font-normal tracking-tight"
          >
            {{ t('pricing.faq.title') }}
          </h2>
          <Faq
            :items="faqItems"
            :json-ld="marketingSite"
          />
        </section>
      </template>

      <!-- ═══ Self-hosted: the limits of this instance ═══ -->
      <PricingInstanceLimits
        v-else
        :tiers="TIERS"
        :current="isCurrent('free')"
      />
    </div>
  </div>
</template>
