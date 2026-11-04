<script setup lang="ts">
import { DEFAULT_TIERS, type PlanName } from '~~/shared/config/tiers'
import {
  DEFAULT_PLAN_PRICES_USD,
  PAID_PLAN_NAMES,
  PRICE_CURRENCY,
  type PaidPlanName,
  type PlanPricesResponse
} from '~~/shared/config/pricing'
import { pricingStructuredData, type FaqItem, type PricingOffer } from '~~/shared/seo/structuredData'
import { pageBreadcrumbs } from '~~/shared/seo/breadcrumbs'

// Pricing page.
//
// Every number is live config: tier caps from `GET /api/billing/tiers`
// (committed defaults + TIER_* overrides, `getTiers()`), prices from
// `GET /api/billing/prices` (`shared/config/pricing.ts` + TIER_*_PRICE_USD),
// the anonymous-document retention from the instance config
// (`NUXT_INACTIVE_DOC_TTL_DAYS`). The committed defaults are the
// SSR/fetch-failure fallback.
//
// Two layouts, three instance shapes (shared/config/billingMode.ts):
//   - Options (billing ON, or billing OFF + NUXT_PLANS_COMING_SOON on the
//     hosted site): four columns — Self-hosted / No account / Free
//     account / Paid (tabs Pro · Max · Ultra) — then a comparison table
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

const [{ data: tiersData }, { data: pricesData }] = await Promise.all([
  useFetch('/api/billing/tiers'),
  useFetch<PlanPricesResponse>('/api/billing/prices')
])
const TIERS = computed(() => tiersData.value ?? DEFAULT_TIERS)
const PRICES = computed(() => pricesData.value?.monthly ?? DEFAULT_PLAN_PRICES_USD)
const CURRENCY = computed(() => pricesData.value?.currency ?? PRICE_CURRENCY)

interface UserBilling {
  plan: PlanName
}
const billing = ref<UserBilling | null>(null)

const optionsLayout = computed(() => billingEnabled.value || plansComingSoon.value)
/** Paid prices are planned, not on sale. */
const pricesPlanned = computed(() => !billingEnabled.value)

const PAID_TAGLINE: Record<PaidPlanName, string> = {
  pro: 'pricing.tiers.pro',
  max: 'pricing.tiers.max',
  ultra: 'pricing.tiers.ultra'
}
const PAID_DISPLAY: Record<PaidPlanName, string> = { pro: 'Pro', max: 'Max', ultra: 'Ultra' }

const paidTab = ref<PaidPlanName>('pro')
const paidTabs = PAID_PLAN_NAMES.map(plan => ({
  label: PAID_DISPLAY[plan],
  value: plan,
  slot: plan
}))
function paidPlanFor(value: string | number | undefined): PaidPlanName | undefined {
  return PAID_PLAN_NAMES.find(plan => plan === value)
}

onMounted(async () => {
  if (!loggedIn.value) return
  try {
    billing.value = await $fetch<UserBilling>('/api/user/billing')
    // Open the tab of the plan the caller is on.
    const current = paidPlanFor(billing.value.plan)
    if (current) paidTab.value = current
  } catch {
    // Non-fatal — the page still renders for unauthenticated visitors
    // and for logged-in users whose billing fetch errored; they just
    // don't get the "your current plan" highlight.
  }
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

// Tier ranking. Drives the "upgrade vs downgrade" CTA split so a Max
// user doesn't see "Upgrade" next to the Pro tab.
const PLAN_ORDER: readonly PlanName[] = ['free', 'pro', 'max', 'ultra']
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
const checkoutLoading = ref<PlanName | null>(null)

async function onChangePlan(plan: PlanName): Promise<void> {
  if (!billingEnabled.value) return
  if (!loggedIn.value) {
    globalThis.location.href = primaryLoginPath.value ?? '/'
    return
  }
  if (plan === 'free' || checkoutLoading.value) return

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
    const resp = await $fetch<{ url?: string, sessionId?: string, updated?: boolean, plan?: PlanName }>('/api/billing/checkout', {
      method: 'POST',
      body: { plan }
    })
    if (resp.updated) {
      toast.add({
        title: 'Plan updated',
        description: `You are now on the ${resp.plan} plan. Your new AI budget is available immediately.`,
        icon: 'i-lucide-check-circle',
        color: 'success'
      })
      checkoutLoading.value = null
      // Refresh the "current plan" highlight. The webhook that flips
      // the plan can lag the API response by a beat — refetch once now
      // and once shortly after so the page settles on the new state.
      try {
        billing.value = await $fetch<UserBilling>('/api/user/billing')
        setTimeout(async () => {
          try {
            billing.value = await $fetch<UserBilling>('/api/user/billing')
          } catch { /* highlight refresh only */ }
        }, 2500)
      } catch { /* highlight refresh only */ }
      return
    }
    // Full-page redirect — Stripe's hosted Checkout is a separate
    // origin, can't be iframed.
    if (resp.url) globalThis.location.href = resp.url
  } catch (e) {
    const err = e as { statusCode?: number, data?: { message?: string }, message?: string }
    toast.add({
      title: 'Could not start checkout',
      description: err.data?.message ?? err.message ?? 'Unknown error',
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
    const { url } = await $fetch<{ url: string }>('/api/billing/portal', {
      method: 'POST'
    })
    globalThis.location.href = url
  } catch (e) {
    const err = e as { statusCode?: number, data?: { message?: string }, message?: string }
    toast.add({
      title: 'Could not open billing portal',
      description: err.data?.message ?? err.message ?? 'Unknown error',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    portalLoading.value = false
  }
}

// ─── FAQ ───────────────────────────────────────────────────────────
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

// ─── SEO ───────────────────────────────────────────────────────────
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
// account always; Pro / Max / Ultra only while billing is on. Planned
// prices are on the page, labelled as planned, but an Offer states a
// price someone can pay — publishing one for a plan nobody can buy
// would put a wrong claim into search results.
// One graph with the page's WebPage + BreadcrumbList (usePageStructuredData
// is marketing-site only too).
usePageStructuredData(() => {
  if (!optionsLayout.value) return null
  const offers: PricingOffer[] = [{ name: t('pricing.freeAccount.title'), price: 0 }]
  if (billingEnabled.value) {
    for (const plan of PAID_PLAN_NAMES) offers.push({ name: PAID_DISPLAY[plan], price: PRICES.value[plan] })
  }
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
      currency: CURRENCY.value,
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
          <article
            :class="[cardClass, 'border-default']"
            data-testid="pricing-option-self-hosted"
          >
            <h2 class="font-serif text-xl font-normal tracking-tight">
              {{ t('pricing.selfHosted.title') }}
            </h2>
            <p class="text-sm text-muted mt-1 lg:min-h-10">
              {{ t('pricing.selfHosted.tagline') }}
            </p>
            <p class="mt-4 font-serif text-3xl font-light tracking-tight">
              {{ t('pricing.price.free') }}
            </p>
            <p class="font-mono text-[11px] uppercase tracking-[0.06em] text-muted mt-1">
              {{ t('pricing.selfHosted.priceNote') }}
            </p>
            <ul class="mt-5 space-y-2 text-sm flex-1">
              <li class="flex gap-2">
                <UIcon
                  name="i-lucide-server"
                  class="size-4 text-muted shrink-0 mt-0.5"
                />
                <span>{{ t('pricing.selfHosted.everyFeature') }}</span>
              </li>
              <li class="flex gap-2">
                <UIcon
                  name="i-lucide-key-round"
                  class="size-4 text-muted shrink-0 mt-0.5"
                />
                <span>{{ t('pricing.selfHosted.byok') }}</span>
              </li>
              <li class="flex gap-2">
                <UIcon
                  name="i-lucide-scale"
                  class="size-4 text-muted shrink-0 mt-0.5"
                />
                <span data-testid="pricing-licence">{{ t('pricing.selfHosted.licence') }}</span>
              </li>
            </ul>
            <UButton
              to="/docs/getting-started/self-hosting"
              color="neutral"
              variant="outline"
              block
              class="mt-6"
              data-testid="pricing-self-hosted-cta"
            >
              {{ t('pricing.selfHosted.cta') }}
            </UButton>
          </article>

          <!-- No account -->
          <article
            :class="[cardClass, 'border-default']"
            data-testid="pricing-option-anon"
          >
            <h2 class="font-serif text-xl font-normal tracking-tight">
              {{ t('pricing.anon.title') }}
            </h2>
            <p class="text-sm text-muted mt-1 lg:min-h-10">
              {{ t('pricing.anon.tagline') }}
            </p>
            <p class="mt-4 font-serif text-3xl font-light tracking-tight">
              {{ t('pricing.price.free') }}
            </p>
            <p class="font-mono text-[11px] uppercase tracking-[0.06em] text-muted mt-1">
              {{ t('pricing.anon.priceNote') }}
            </p>
            <ul class="mt-5 space-y-2 text-sm flex-1">
              <li class="flex gap-2">
                <UIcon
                  name="i-lucide-users"
                  class="size-4 text-muted shrink-0 mt-0.5"
                />
                <span>{{ t('pricing.anon.write') }}</span>
              </li>
              <li class="flex gap-2">
                <UIcon
                  name="i-lucide-file-down"
                  class="size-4 text-muted shrink-0 mt-0.5"
                />
                <span>{{ t('pricing.anon.export') }}</span>
              </li>
              <li class="flex gap-2">
                <UIcon
                  name="i-lucide-minus"
                  class="size-4 text-muted shrink-0 mt-0.5"
                />
                <span data-testid="pricing-anon-limits">{{ t('pricing.anon.noAi') }}</span>
              </li>
              <li
                v-if="anonDocTtlDays > 0"
                class="flex gap-2"
              >
                <UIcon
                  name="i-lucide-clock"
                  class="size-4 text-muted shrink-0 mt-0.5"
                />
                <span data-testid="pricing-anon-retention">{{ t('pricing.anon.retention', { n: formatCount(anonDocTtlDays, locale) }, anonDocTtlDays) }}</span>
              </li>
              <li class="flex gap-2">
                <UIcon
                  name="i-lucide-trash-2"
                  class="size-4 text-muted shrink-0 mt-0.5"
                />
                <span>{{ t('pricing.anon.delete') }}</span>
              </li>
            </ul>
            <MarketingStartButton
              class="mt-6 block [&>button]:w-full [&>button]:justify-center"
              testid="pricing-anon-cta"
            />
          </article>

          <!-- Free account -->
          <article
            :class="[cardClass, isCurrent('free') ? 'border-inverted' : 'border-default']"
            data-testid="pricing-tier-free"
            :data-current="isCurrent('free')"
            data-coming-soon="false"
          >
            <div
              v-if="isCurrent('free')"
              data-testid="pricing-current-plan-badge"
              :class="badgeClass"
            >
              {{ t('pricing.currentPlan') }}
            </div>
            <h2 class="font-serif text-xl font-normal tracking-tight">
              {{ t('pricing.freeAccount.title') }}
            </h2>
            <p class="text-sm text-muted mt-1 lg:min-h-10">
              {{ t('pricing.tiers.free') }}
            </p>
            <p class="mt-4 font-serif text-3xl font-light tracking-tight">
              {{ t('pricing.price.free') }}
            </p>
            <p class="font-mono text-[11px] uppercase tracking-[0.06em] text-muted mt-1">
              {{ t('pricing.availableNow') }}
            </p>
            <div class="mt-5 flex-1">
              <PricingCapsList
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
            </div>
            <div class="mt-6">
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
                v-else-if="billingEnabled && paidPlanFor(billing?.plan)"
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
            </div>
          </article>

          <!-- Paid: Pro · Max · Ultra -->
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
                    <span class="text-sm text-muted">{{ t('pricing.price.perMonth') }}</span>
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
                  <p class="text-sm text-muted mt-3">
                    {{ t(PAID_TAGLINE[plan]) }}
                  </p>
                  <PricingCapsList
                    class="mt-4 flex-1"
                    :plan="plan"
                    :tiers="TIERS"
                    :sponsoring="plan === 'max' || plan === 'ultra'"
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
                    <UButton
                      v-else
                      block
                      color="neutral"
                      :loading="checkoutLoading === plan"
                      @click="onChangePlan(plan)"
                    >
                      {{ loggedIn ? t('pricing.upgrade') : t('pricing.signUp') }}
                    </UButton>
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

        <PricingCompareTable
          :tiers="TIERS"
          :prices="PRICES"
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
