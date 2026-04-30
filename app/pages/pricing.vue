<script setup lang="ts">
import { TIERS, type PlanName } from '~~/shared/config/tiers'

// Pricing page. Shows every tier with live caps read from the shared
// config + the caller's current plan highlighted. Upgrade buttons
// open a Stripe Checkout Session; downgrade / "Manage subscription"
// opens the Customer Portal.
//
// Tier caps are imported directly from `shared/config/tiers.ts` so
// changing a number there re-renders the page without any copy edit.

const { t } = useI18n()
const { loggedIn } = useUserSession()

interface UserBilling {
  plan: PlanName
  interactionsRemaining: number
  interactionsLimit: number
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

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    const gb = bytes / (1024 * 1024 * 1024)
    return `${gb % 1 === 0 ? gb.toFixed(0) : gb.toFixed(1)} GB`
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

function fmtMinutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min/day`
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
  if (!loggedIn.value) {
    window.location.href = '/auth/github'
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

  // Upgrade path → Checkout Session.
  checkoutLoading.value = plan
  try {
    const { url } = await $fetch<{ url: string, sessionId: string }>('/api/billing/checkout', {
      method: 'POST',
      body: { plan }
    })
    // Full-page redirect — Stripe's hosted Checkout is a separate
    // origin, can't be iframed.
    window.location.href = url
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
  if (portalLoading.value) return
  portalLoading.value = true
  try {
    const { url } = await $fetch<{ url: string }>('/api/billing/portal', {
      method: 'POST'
    })
    window.location.href = url
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
  if (window.history.length > 1 && document.referrer) {
    router.back()
  } else {
    router.push('/')
  }
}

useHead({
  title: t('pricing.title') + ' · YPad'
})
</script>

<template>
  <div class="min-h-[100dvh] bg-default text-default relative">
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
          {{ t('pricing.title') }}
        </h1>
        <p class="mt-3 text-sm sm:text-base text-muted">
          {{ t('pricing.subtitle') }}
        </p>
        <p class="mt-2 text-xs text-muted">
          {{ t('pricing.creditsHint') }}
        </p>
      </div>

      <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <article
          v-for="tier in TIER_COPY"
          :key="tier.plan"
          class="relative border rounded-lg p-4 sm:p-6 flex flex-col"
          :class="[
            isCurrent(tier.plan)
              ? 'border-shu-500 ring-2 ring-shu-500/30 bg-shu-500/5 dark:bg-shu-400/5'
              : 'border-default'
          ]"
        >
          <div
            v-if="tier.badge"
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
            <div class="mt-4">
              <span class="text-3xl font-bold">{{ tier.priceMonthly }}</span>
              <span
                v-if="tier.plan !== 'free'"
                class="text-sm text-muted ml-1"
              >/mo</span>
            </div>
          </div>

          <ul class="mt-6 space-y-2 text-sm flex-1">
            <li class="flex items-baseline gap-2">
              <CommonSeal
                :size="9"
                class="shrink-0 self-center mt-0.5"
              />
              <span>
                <strong>{{ TIERS[tier.plan].interactionsPerMonth.toLocaleString() }}</strong>
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
            <li class="flex gap-2">
              <UIcon
                name="i-lucide-mic"
                class="size-4 text-muted shrink-0 mt-0.5"
              />
              <span>
                <strong>{{ fmtMinutes(TIERS[tier.plan].dictationMsPerDay) }}</strong>
                {{ t('pricing.dictation') }}
              </span>
            </li>
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

          <div class="mt-6">
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

      <div class="mt-8 sm:mt-12 text-center text-sm text-muted">
        <p>{{ t('pricing.footnote') }}</p>
      </div>
    </main>
  </div>
</template>
