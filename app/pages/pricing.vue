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
import { MIN_WORKSPACE_SEATS } from '~~/shared/config/workspaceSeats'

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
//   - Options (billing ON, or billing OFF + NUXT_PLANS_COMING_SOON on the
//     hosted site): four columns — Self-hosted / No account / Free
//     account / Paid (tabs Pro · Team · Business) — then a comparison table
//     and an FAQ.
//       · billing on: real prices + Stripe Checkout / Customer Portal CTAs.
//       · coming soon: PLANNED prices, labelled as planned, no purchase
//         button, the double-opt-in waitlist right under the columns.
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

const paidTab = ref<PaidPlanName>('pro')
const paidTabs = PAID_PLAN_NAMES.map(plan => ({
  label: PAID_DISPLAY[plan],
  value: plan,
  slot: plan
}))
function paidPlanFor(value: string | number | undefined): PaidPlanName | undefined {
  return PAID_PLAN_NAMES.find(plan => plan === value)
}

// Open the tab of the plan the caller is on, once it is known.
watch(() => billing.value?.plan, (plan) => {
  const current = paidPlanFor(plan)
  if (current) paidTab.value = current
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

function isCurrent(plan: PlanName): boolean {
  return billing.value?.plan === plan
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
  // (prorated, charged immediately) and `{ updated: true }` back —
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
      // The plan, its limits and the AI budgets changed — for this page's
      // highlight and for the topbar badge alike. The webhook that flips
      // the plan can lag the API response by a beat: re-read once now and
      // once shortly after so everything settles on the new state.
      await invalidatePlan()
      setTimeout(() => {
        void invalidatePlan()
      }, 2500)
      return
    }
    // Full-page redirect — Stripe's hosted Checkout is a separate
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
  items.push({ q: t('pricing.faq.byokQ'), a: t('pricing.faq.byokA') })
  items.push({ q: t('pricing.faq.pointsQ'), a: t('pricing.creditsHint') })
  // The EU data path is a statement about markoto.app's own providers —
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
// price someone can pay — publishing one for a plan nobody can buy
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
  const offers: PricingOffer[] = [{ name: t('pricing.freeAccount.title'), price: 0 }, ...(billingEnabled.value ? paidOffers() : [])]
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

const cardClass = 'relative rounded-lg border bg-default p-5 flex flex-col'
const badgeClass = 'absolute -top-3 left-5 bg-inverted text-inverted font-mono text-[10.5px] tracking-[0.06em] uppercase px-2.5 py-0.5 rounded-full'
</script>

<template>
  <div>
    <!-- Header + footer come from the `marketing` layout. -->
    <div class="max-w-6xl mx-auto px-4 py-8 sm:py-12">
      <div class="text-center mb-8 sm:mb-12">
        <h1 class="font-serif text-3xl sm:text-5xl font-light tracking-tight">
          {{ pageTitle }}
        </h1>
        <p
          class="mt-3 text-sm sm:text-base text-muted max-w-2xl mx-auto"
          data-testid="pricing-subtitle"
        >
          {{ pageSubtitle }}
        </p>
      </div>

      <!-- ═══ Options layout (hosted site / billing on) ═══ -->
      <template v-if="optionsLayout">
        <div
          class="grid gap-4 md:grid-cols-2 lg:grid-cols-4"
          data-testid="pricing-options"
        >
          <!-- Self-hosted -->
          <PricingSelfHostedOption />

          <!-- No account -->
          <PricingAnonOption />

          <!-- Free account -->
          <PricingFreeAccountOption
            :current="isCurrent('free')"
            :can-downgrade="billingEnabled && !!paidPlanFor(billing?.plan)"
            :portal-loading="portalLoading"
            :tiers="TIERS"
            @portal="openPortal"
          />

          <!-- Paid: Pro · Team · Business (Team / Business per seat) -->
          <article
            :class="[cardClass, paidPlanFor(billing?.plan) ? 'border-inverted' : 'border-default']"
            data-testid="pricing-option-paid"
          >
            <div
              v-if="pricesPlanned"
              data-testid="pricing-coming-soon-badge"
              :class="badgeClass"
            >
              {{ t('pricing.comingSoonBadge') }}
            </div>
            <h2 class="font-serif text-xl font-normal tracking-tight">
              {{ t('pricing.paid.title') }}
            </h2>
            <p class="text-sm text-muted mt-1 lg:min-h-10">
              {{ t('pricing.paid.tagline') }}
            </p>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <UTabs
                v-model="interval"
                :items="intervalItems"
                :content="false"
                color="neutral"
                variant="link"
                size="xs"
                :aria-label="t('pricing.interval.label')"
                data-testid="pricing-interval"
              />
              <USelect
                v-model="currency"
                :items="currencyItems"
                size="xs"
                class="ml-auto w-20"
                :aria-label="t('pricing.currencyLabel')"
                data-testid="pricing-currency"
              />
            </div>
            <UTabs
              v-model="paidTab"
              :items="paidTabs"
              :unmount-on-hide="false"
              color="neutral"
              size="sm"
              class="mt-4 flex-1 gap-0"
              :ui="{ list: 'w-full', trigger: 'flex-1 justify-center', content: 'flex flex-col flex-1' }"
              :aria-label="t('pricing.paid.tabsLabel')"
              data-testid="pricing-paid-tabs"
            >
              <template
                v-for="plan in PAID_PLAN_NAMES"
                :key="plan"
                #[plan]
              >
                <div
                  class="flex flex-col flex-1 pt-4"
                  :data-testid="`pricing-tier-${plan}`"
                  :data-current="isCurrent(plan)"
                  :data-coming-soon="pricesPlanned"
                >
                  <div class="flex items-baseline gap-1.5 flex-wrap">
                    <span
                      class="font-serif text-3xl font-light tracking-tight"
                      data-testid="pricing-price"
                    >{{ price(plan) }}</span>
                    <span class="text-sm text-muted">{{ t(priceUnitKey(plan)) }}</span>
                    <span
                      v-if="isCurrent(plan)"
                      data-testid="pricing-current-plan-badge"
                      class="ml-auto bg-inverted text-inverted font-mono text-[10.5px] tracking-[0.06em] uppercase px-2 py-0.5 rounded-full"
                    >
                      {{ t('pricing.currentPlan') }}
                    </span>
                  </div>
                  <p class="font-mono text-[11px] uppercase tracking-[0.06em] text-muted mt-1">
                    {{ pricesPlanned ? t('pricing.price.planned') : t('pricing.availableNow') }}
                  </p>
                  <div
                    v-if="isPerSeatPlan(plan)"
                    class="mt-3 flex items-center gap-2 flex-wrap"
                  >
                    <UInputNumber
                      v-model="seats"
                      :min="MIN_WORKSPACE_SEATS"
                      :max="1000"
                      size="xs"
                      class="w-28"
                      :aria-label="t('pricing.seatsLabel')"
                      :data-testid="`pricing-seats-${plan}`"
                    />
                    <span
                      class="text-sm text-muted"
                      :data-testid="`pricing-seat-total-${plan}`"
                    >{{ seatTotal(plan) }}</span>
                  </div>
                  <p class="text-sm text-muted mt-3">
                    {{ t(PAID_TAGLINE[plan]) }}
                  </p>
                  <PricingCapsList
                    class="mt-4 flex-1"
                    :plan="plan"
                    :tiers="TIERS"
                  />
                  <div class="mt-6">
                    <!-- Coming soon: nothing to buy, the waitlist is right below. -->
                    <UButton
                      v-if="pricesPlanned"
                      to="#waitlist"
                      block
                      color="neutral"
                      variant="outline"
                      data-testid="pricing-join-waitlist"
                    >
                      {{ t('pricing.paid.joinWaitlist') }}
                    </UButton>
                    <!-- Team / Business are bought for a workspace, from its
                         billing settings. -->
                    <template v-else-if="isPerSeatPlan(plan)">
                      <UButton
                        to="/"
                        block
                        color="neutral"
                        variant="outline"
                        :data-testid="`pricing-workspace-plan-${plan}`"
                      >
                        {{ t('pricing.paid.setUpInWorkspace') }}
                      </UButton>
                      <p class="mt-2 text-xs text-muted">
                        {{ t('pricing.paid.setUpInWorkspaceHint') }}
                      </p>
                    </template>
                    <!-- Billing on: current → Customer Portal; higher →
                         upgrade (Checkout or in-place swap); lower →
                         portal downgrade; logged out → sign up. -->
                    <UButton
                      v-else-if="ctaKind(plan) === 'current'"
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
                      v-else-if="ctaKind(plan) === 'downgrade'"
                      block
                      color="neutral"
                      variant="outline"
                      :loading="portalLoading"
                      @click="onChangePlan(plan)"
                    >
                      {{ t('pricing.downgrade') }}
                    </UButton>
                    <template v-else>
                      <PricingPaidTermsConsent
                        v-if="loggedIn"
                        v-model="paidTermsAccepted"
                        kind="plan"
                        class="mb-3"
                        :testid="`pricing-paid-terms-${plan}`"
                      />
                      <UButton
                        block
                        color="neutral"
                        :disabled="loggedIn && !paidTermsAccepted"
                        :loading="checkoutLoading === plan"
                        :data-testid="`pricing-buy-${plan}`"
                        @click="onChangePlan(plan)"
                      >
                        {{ loggedIn ? t('pricing.upgrade') : t('pricing.signUp') }}
                      </UButton>
                    </template>
                  </div>
                </div>
              </template>
            </UTabs>
            <p
              v-if="pricesPlanned"
              class="mt-3 text-xs text-muted"
              data-testid="pricing-planned-note"
            >
              {{ t('pricing.price.plannedNote') }}
            </p>
          </article>
        </div>

        <!-- Paid-plans waitlist (hosted free-only SaaS only), directly
             under the columns (right after the Paid card on phones; on
             wide screens under Free + Paid, the notes on the left). -->
        <div class="mt-6 grid gap-6 lg:grid-cols-2 items-start">
          <div
            v-if="plansComingSoon"
            id="waitlist"
            class="scroll-mt-24 lg:order-2"
          >
            <PricingWaitlistForm />
          </div>
          <div class="text-sm text-muted space-y-2 lg:order-1 lg:pt-2">
            <p>{{ billingEnabled ? t('pricing.footnote') : t('pricing.freeFootnote') }}</p>
            <p
              v-if="plansComingSoon"
              data-testid="pricing-free-allowance-note"
            >
              {{ t('pricing.freeAllowanceNote') }}
            </p>
            <p
              v-if="plansComingSoon"
              data-testid="pricing-coming-soon-footnote"
            >
              {{ t('pricing.comingSoonFootnote') }}
            </p>
          </div>
        </div>

        <!-- AI credit top-ups: one-off, for paid plans. -->
        <section
          v-if="optionsLayout"
          class="mt-8 rounded-lg border border-default bg-default p-5"
          data-testid="pricing-credits"
        >
          <div class="flex items-center gap-2">
            <CommonSeal :size="9" />
            <h2 class="font-serif text-lg font-normal tracking-tight">
              {{ t('credits.title') }}
            </h2>
          </div>
          <p class="mt-2 text-sm text-muted max-w-3xl">
            {{ t('pricing.creditsSection', { months: TOPUP_VALIDITY_MONTHS }) }}
          </p>
          <p class="mt-3 text-sm">
            <span
              v-for="(pack, i) in TOPUP_PACKS"
              :key="pack.id"
            >{{ i > 0 ? ' · ' : '' }}{{ formatPrice(pack.price[currency], CURRENCY, locale) }} → {{ formatUsd(pack.creditUsd, locale) }}</span>
          </p>
          <p
            v-if="pricesPlanned"
            class="mt-2 text-xs text-muted"
          >
            {{ t('pricing.price.planned') }}
          </p>
        </section>

        <!-- Below the columns: hydrates when scrolled to (the server
             render is the whole table). -->
        <LazyPricingCompareTable
          hydrate-on-visible
          :tiers="TIERS"
          :prices="MONTHLY_PRICES"
          :currency="CURRENCY"
          :planned="pricesPlanned"
          :anon-ttl-days="anonDocTtlDays"
        />

        <section
          class="mt-12 sm:mt-16 max-w-3xl"
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
      <template v-else>
        <article
          :class="[cardClass, 'border-default max-w-sm mx-auto']"
          data-testid="pricing-tier-free"
          :data-current="isCurrent('free')"
          data-coming-soon="false"
        >
          <h2 class="font-serif text-xl font-normal tracking-tight">
            {{ t('pricing.instance.title') }}
          </h2>
          <p class="text-sm text-muted mt-1">
            {{ t('pricing.tiers.free') }}
          </p>
          <PricingCapsList
            class="mt-5"
            plan="free"
            :tiers="TIERS"
          />
          <p class="mt-3 flex gap-2 text-sm">
            <UIcon
              name="i-lucide-key-round"
              class="size-4 text-muted shrink-0 mt-0.5"
            />
            <span>{{ t('pricing.freeAccount.byok') }}</span>
          </p>
        </article>
        <div class="mt-8 text-center text-sm text-muted space-y-2 max-w-2xl mx-auto">
          <p>{{ t('pricing.freeFootnote') }}</p>
          <p>{{ t('pricing.creditsHint') }}</p>
        </div>
      </template>
    </div>
  </div>
</template>
