<script setup lang="ts">
import { DEFAULT_TIERS, type PlanName } from '~~/shared/config/tiers'
import { planToPointsTotal } from '~~/shared/billing/aiPoints'

// Pricing page. Shows every tier with live caps + the caller's current
// plan highlighted. Upgrade buttons open a Stripe Checkout Session;
// downgrade / "Manage subscription" opens the Customer Portal.
//
// Tier caps come from `GET /api/billing/tiers` — the server-RESOLVED
// map (committed defaults + any TIER_* env overrides), so the hosted
// deployment can adjust a cap without a rebuild. The committed
// DEFAULT_TIERS serve as the SSR/fetch-failure fallback; in a stock
// self-host deployment the two are identical.
//
// Three modes (see shared/config/billingMode.ts):
//   - billing ON → everything below behaves exactly as before (Stripe
//     Checkout / Customer Portal CTAs).
//   - billing OFF + plans coming soon (hosted free-only SaaS) → every
//     tier is shown, paid tiers carry a "coming soon" state with no
//     price and no purchase button, plus the waitlist sign-up.
//   - billing OFF, self-hosted → only the limits every account on this
//     instance gets; no tiers, no prices, no waitlist.

const { t } = useI18n()
const { loggedIn } = useUserSession()
// Login starts at the first configured OAuth provider ('/' when none).
const { primaryLoginPath } = useInstanceConfig()
const { billingEnabled, plansComingSoon } = useBillingMode()

const { data: tiersData } = await useFetch('/api/billing/tiers')
const TIERS = computed(() => tiersData.value ?? DEFAULT_TIERS)

interface UserBilling {
  plan: PlanName
}
const billing = ref<UserBilling | null>(null)
onMounted(async () => {
  if (!loggedIn.value) return
  try {
    billing.value = await $fetch<UserBilling>('/api/user/billing')
  } catch {
    // Non-fatal — the page still renders for unauthenticated visitors
    // and for logged-in users whose billing fetch errored; they just
    // don't get the "your current plan" highlight.
  }
})

interface TierCopy {
  plan: PlanName
  displayName: string
  priceMonthly: string
  tagline: string
  badge?: string
}
const TIER_COPY: TierCopy[] = [
  {
    plan: 'free',
    displayName: 'Free',
    priceMonthly: '$0',
    tagline: 'Try it out, draft a doc with AI, see if it fits.'
  },
  {
    plan: 'pro',
    displayName: 'Pro',
    priceMonthly: '$10',
    tagline: 'Solo power users. Your own AI credits on every doc you touch.'
  },
  {
    plan: 'max',
    displayName: 'Max',
    priceMonthly: '$50',
    tagline: 'Small teams. Turn any workspace you own into an AI workspace so members share your credit pool.',
    badge: 'Most popular'
  },
  {
    plan: 'ultra',
    displayName: 'Ultra',
    priceMonthly: '$100',
    tagline: 'Large teams. Same AI-workspace sponsorship, bigger pool.'
  }
]

// Self-hosted instances only show the one tier every account gets.
const visibleTiers = computed(() =>
  billingEnabled.value || plansComingSoon.value
    ? TIER_COPY
    : TIER_COPY.filter(tier => tier.plan === 'free')
)

// Billing off: a paid tier is a preview, not a product.
function isComingSoon(plan: PlanName): boolean {
  return !billingEnabled.value && plan !== 'free'
}

const pageTitle = computed(() =>
  billingEnabled.value || plansComingSoon.value ? t('pricing.title') : t('pricing.selfHostedTitle')
)
const pageSubtitle = computed(() => {
  if (billingEnabled.value) return t('pricing.subtitle')
  return plansComingSoon.value ? t('pricing.comingSoonSubtitle') : t('pricing.selfHostedSubtitle')
})

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    const gb = bytes / (1024 * 1024 * 1024)
    return `${gb % 1 === 0 ? gb.toFixed(0) : gb.toFixed(1)} GB`
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

function isCurrent(plan: PlanName): boolean {
  return billing.value?.plan === plan
}

// Tier ranking. Drives the "upgrade vs downgrade" CTA split so a Max
// user doesn't see "Upgrade" next to the Pro card. The order matches
// the array across the page so indexOf is safe.
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

const toast = useToast()
const router = useRouter()

// Close button — go back if there's a referrer in history, otherwise
// fall back to home. Keeps the pricing page feeling modal-ish: users
// don't lose the context they came from (doc / workspace).
function onClose(): void {
  // `history.state.back` is Nuxt's accessor for the prior route; if we
  // got here via a direct navigation (no back stack), route to home.
  if (globalThis.history.length > 1 && document.referrer) {
    router.back()
  } else {
    router.push('/')
  }
}

useHead({
  title: () => pageTitle.value + ' · markoto'
})
</script>

<template>
  <div class="min-h-[100dvh] bg-default text-default relative">
    <CommonHomeLink />
    <!-- Modal-style close. Returns to the prior page so the pricing
         page feels like an overlay on the user's context rather than
         a destination they've navigated away into. -->
    <UButton
      icon="i-lucide-x"
      color="neutral"
      variant="ghost"
      size="md"
      class="absolute top-4 right-4 z-10"
      :aria-label="t('pricing.close')"
      @click="onClose"
    />

    <main class="max-w-6xl mx-auto px-3 sm:px-4 py-6 sm:py-12">
      <div class="text-center mb-6 sm:mb-10">
        <h1 class="font-serif text-3xl sm:text-4xl font-normal tracking-tight">
          {{ pageTitle }}
        </h1>
        <p
          class="mt-3 text-sm sm:text-base text-muted"
          data-testid="pricing-subtitle"
        >
          {{ pageSubtitle }}
        </p>
        <p class="mt-2 text-xs text-muted">
          {{ t('pricing.creditsHint') }}
        </p>
      </div>

      <div
        class="grid gap-4"
        :class="visibleTiers.length > 1 ? 'md:grid-cols-2 lg:grid-cols-4' : 'max-w-sm mx-auto'"
      >
        <article
          v-for="tier in visibleTiers"
          :key="tier.plan"
          :data-testid="`pricing-tier-${tier.plan}`"
          :data-current="isCurrent(tier.plan)"
          :data-coming-soon="isComingSoon(tier.plan)"
          class="relative border rounded-lg p-4 sm:p-6 flex flex-col"
          :class="[
            isCurrent(tier.plan)
              ? 'border-shu-500 ring-2 ring-shu-500/30 bg-shu-500/5 dark:bg-shu-400/5'
              : 'border-default'
          ]"
        >
          <!-- Card badge. The "current plan" pill takes precedence
               over the static "Most popular" / "Best value" badge
               because what matters most is "where am I right now"
               — knowing the recommended tier is secondary once the
               user can locate themselves on the grid. -->
          <div
            v-if="isCurrent(tier.plan)"
            data-testid="pricing-current-plan-badge"
            class="absolute -top-3 left-1/2 -translate-x-1/2 bg-shu-500 text-white font-mono text-[10.5px] tracking-[0.06em] uppercase font-medium px-2.5 py-0.5 rounded-full"
          >
            {{ t('pricing.currentPlan') }}
          </div>
          <div
            v-else-if="isComingSoon(tier.plan)"
            data-testid="pricing-coming-soon-badge"
            class="absolute -top-3 left-1/2 -translate-x-1/2 bg-sumi-900 text-sumi-50 dark:bg-sumi-100 dark:text-sumi-900 font-mono text-[10.5px] tracking-[0.06em] uppercase font-medium px-2.5 py-0.5 rounded-full"
          >
            {{ t('pricing.comingSoonBadge') }}
          </div>
          <div
            v-else-if="billingEnabled && tier.badge"
            class="absolute -top-3 left-1/2 -translate-x-1/2 bg-shu-500 text-white font-mono text-[10.5px] tracking-[0.06em] uppercase font-medium px-2.5 py-0.5 rounded-full"
          >
            {{ tier.badge }}
          </div>

          <div>
            <h2 class="text-lg font-semibold">
              {{ tier.displayName }}
            </h2>
            <p class="text-sm text-muted mt-1 min-h-[3em]">
              {{ tier.tagline }}
            </p>
            <!-- Prices only when there's something to buy: paid prices
                 aren't final while plans are "coming soon", and a
                 self-hosted instance has no prices at all. -->
            <div
              v-if="billingEnabled"
              class="mt-4"
            >
              <span class="text-3xl font-bold">{{ tier.priceMonthly }}</span>
              <span
                v-if="tier.plan !== 'free'"
                class="text-sm text-muted ml-1"
              >/mo</span>
            </div>
            <div
              v-else
              class="mt-4 font-mono text-[11px] uppercase tracking-[0.06em] text-muted"
            >
              {{ isComingSoon(tier.plan) ? t('pricing.comingSoonBadge') : t('pricing.availableNow') }}
            </div>
          </div>

          <ul class="mt-6 space-y-2 text-sm flex-1">
            <li class="flex items-baseline gap-2">
              <CommonSeal
                :size="9"
                class="shrink-0 self-center mt-0.5"
              />
              <span>
                <strong>{{ planToPointsTotal(tier.plan, TIERS).toLocaleString() }}</strong>
                {{ t('pricing.aiCreditsPerMonth') }}
              </span>
            </li>
            <li class="flex gap-2">
              <UIcon
                name="i-lucide-folder"
                class="size-4 text-muted shrink-0 mt-0.5"
              />
              <span>
                <strong>{{ TIERS[tier.plan].workspacesOwned }}</strong>
                {{ t('pricing.workspaces') }}
              </span>
            </li>
            <li class="flex gap-2">
              <UIcon
                name="i-lucide-file-text"
                class="size-4 text-muted shrink-0 mt-0.5"
              />
              <span>
                <strong>{{ TIERS[tier.plan].knowledgeFiles }}</strong>
                {{ t('pricing.knowledgeFiles') }}
              </span>
            </li>
            <li class="flex gap-2">
              <UIcon
                name="i-lucide-hard-drive"
                class="size-4 text-muted shrink-0 mt-0.5"
              />
              <span>
                <strong>{{ fmtBytes(TIERS[tier.plan].knowledgeBytesPerUser) }}</strong>
                {{ t('pricing.knowledgeStorage') }}
              </span>
            </li>
            <!-- Phase 6: dictation cap retired. Voice dictation runs against the same AI Points budget as everything else. -->

            <li
              v-if="tier.plan === 'max' || tier.plan === 'ultra'"
              class="flex gap-2"
            >
              <UIcon
                name="i-lucide-circle-plus"
                class="size-4 text-shu-500 dark:text-shu-400 shrink-0 mt-0.5"
              />
              <span class="text-shu-500 dark:text-shu-400">
                {{ t('pricing.teamBilling') }}
              </span>
            </li>
          </ul>

          <!-- Billing off: no purchase surface at all. Free is "your
               plan" (signed in) or "free forever"; paid tiers are a
               disabled "coming soon" chip. -->
          <div
            v-if="!billingEnabled"
            class="mt-6"
          >
            <UButton
              v-if="isComingSoon(tier.plan)"
              disabled
              block
              variant="subtle"
              color="neutral"
              data-testid="pricing-coming-soon-button"
            >
              {{ t('pricing.comingSoonBadge') }}
            </UButton>
            <UButton
              v-else
              disabled
              block
              variant="subtle"
            >
              {{ loggedIn ? t('pricing.currentPlan') : t('pricing.freeForever') }}
            </UButton>
          </div>
          <div
            v-else
            class="mt-6"
          >
            <!-- Four CTA states:
                 - current: disabled "Current plan" chip
                 - free-stay: anonymous visitor viewing Free → disabled "Free forever"
                 - upgrade: higher tier than caller → primary CTA
                 - downgrade: lower tier than caller → neutral/ghost CTA (we
                   don't want to nudge paying users out, and a blue
                   "Upgrade" button on the Pro card when viewing as Max
                   misrepresents the direction). -->
            <!-- Current plan: Free shows disabled "Current plan"; a
                 paid tier shows a clickable "Manage subscription"
                 button that opens the Stripe Customer Portal. That's
                 where users cancel, update their card, download
                 invoices, etc. -->
            <UButton
              v-if="ctaKind(tier.plan) === 'current' && tier.plan === 'free'"
              disabled
              block
              variant="subtle"
            >
              {{ t('pricing.currentPlan') }}
            </UButton>
            <UButton
              v-else-if="ctaKind(tier.plan) === 'current'"
              block
              variant="subtle"
              icon="i-lucide-external-link"
              :loading="portalLoading"
              @click="openPortal"
            >
              {{ t('pricing.manageSubscription') }}
            </UButton>
            <UButton
              v-else-if="ctaKind(tier.plan) === 'free-stay'"
              disabled
              block
              variant="ghost"
            >
              {{ t('pricing.freeForever') }}
            </UButton>
            <UButton
              v-else-if="ctaKind(tier.plan) === 'downgrade'"
              block
              color="neutral"
              variant="soft"
              :loading="portalLoading"
              @click="onChangePlan(tier.plan)"
            >
              {{ t('pricing.downgrade') }}
            </UButton>
            <UButton
              v-else
              block
              :loading="checkoutLoading === tier.plan"
              @click="onChangePlan(tier.plan)"
            >
              {{ loggedIn ? t('pricing.upgrade') : t('pricing.signUp') }}
            </UButton>
          </div>
        </article>
      </div>

      <div class="mt-8 sm:mt-12 text-center text-sm text-muted space-y-2">
        <p>{{ billingEnabled ? t('pricing.footnote') : t('pricing.freeFootnote') }}</p>
        <p
          v-if="plansComingSoon"
          data-testid="pricing-coming-soon-footnote"
        >
          {{ t('pricing.comingSoonFootnote') }}
        </p>
      </div>

      <!-- Paid-plans waitlist (hosted free-only SaaS only). -->
      <div
        v-if="plansComingSoon"
        class="mt-8 sm:mt-12 max-w-xl mx-auto"
      >
        <PricingWaitlistForm />
      </div>
    </main>

    <CommonLegalFooter />
  </div>
</template>
