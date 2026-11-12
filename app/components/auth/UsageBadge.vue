<script setup lang="ts">
// Topbar usage badge. Shows the caller's plan name + a percentage bar
// of remaining AI credits in the current billing period. Colours:
//   ≥25% remaining → green
//   10-25%         → orange
//   <10%           → red
// Click-to-open popover (not a hover tooltip) so the content can be a real
// card and the upgrade button stays clickable.
//
// Billing off (self-hosted / free-only SaaS): the AI-points meter stays
// — every account still has a monthly AI budget that drains and
// refills, so "how much is left, when does it reset" is real
// information. What goes away is everything that only exists to sell:
// the plan name (everyone is on the same tier), the one-click upgrade
// and the "top plan" line. On the hosted SaaS (`plansComingSoon`) the
// footer links to the pricing page's "coming soon" + waitlist instead.
//
// Below the AI meter sits a "Storage & limits" section (`AuthUsageLimits`:
// images, knowledge files + bytes, owned workspaces). Users whose AI runs
// entirely on their own key get the same popover with only that section
// plus the own-key note, so the limits stay reachable for them too.

import type { PlanName } from '~~/shared/config/tiers'
import { useAiCredits } from '~/composables/ai/useAiCredits'

const { t, locale } = useI18n()
const router = useRouter()
const { billing, refresh: refreshBilling } = useBilling()
const { pointsRemaining, pointsTotal, fillRatio, isFreeAllowanceExhausted } = useAiCredits()
const { billingEnabled, plansComingSoon } = useBillingMode()
// AI Points only measure platform-paid AI (an operator's model-alias
// defaults). Calls on the user's own key never touch them, so the meter is
// hidden when nothing the user can do spends points — and says so when they
// mix own keys with defaults.
const { anyPlatformBilled, availability } = useAiAvailability()
const usesOwnKey = computed(() => {
  const a = availability.value
  if (!a) return false
  return a.chat.source === 'user' || a.image.source === 'user' || a.transcription.source === 'user'
})

// Every AI capability runs on the user's own key: no points to show,
// just say whose provider it is (links the settings page).
const ownProviderOnly = computed(() => !anyPlatformBilled.value && usesOwnKey.value)

const planLabel = computed(() => {
  const plan = billing.value?.plan ?? 'free'
  return plan.charAt(0).toUpperCase() + plan.slice(1)
})

// Pct-remaining = AI Points remaining ÷ total. Drives both the bar
// width and the colour bucket.
const pctRemaining = computed(() => {
  return Math.max(0, Math.min(100, Math.round(fillRatio.value * 100)))
})

const barColor = computed(() => {
  const pct = pctRemaining.value
  // Full class names so Tailwind's JIT sees them at build time.
  if (pct < 10) return 'bg-red-500'
  if (pct < 25) return 'bg-orange-500'
  return 'bg-emerald-500'
})

// Reset date = `periodEnd`, straight from the server. Matches Stripe's
// invoice date for paid users (anniversary) and first-of-next-month
// for free users. Deriving locally as `periodStart + 1 month` would be
// wrong for different month lengths and would miss paid anniversaries.
const resetDate = computed(() => {
  const iso = billing.value?.periodEnd
  if (!iso) return ''
  const end = new Date(iso)
  try {
    return new Intl.DateTimeFormat(locale.value, { month: 'short', day: 'numeric', year: 'numeric' }).format(end)
  } catch {
    return end.toISOString().slice(0, 10)
  }
})

// The "upgrade" CTA only makes sense when there's a personal plan above
// us: Free → Pro. Pro is the top personal plan (Team / Business are
// bought for a workspace), so Pro users see a status line instead.
const nextPlan = computed((): PlanName | null => {
  const plan = billing.value?.plan ?? 'free'
  return plan === 'free' ? 'pro' : null
})
const canUpgrade = computed(() => billingEnabled.value && nextPlan.value !== null)

const open = ref(false)

// Counts change on uploads / workspace creation without anything else
// invalidating the shared billing state — re-fetch on every open.
watch(open, (isOpen) => {
  if (isOpen) void refreshBilling()
})

// Upgrade → the pricing page: every purchase goes through the Paid Plans
// Terms box there.
function onUpgrade(): void {
  open.value = false
  router.push('/pricing')
}

function onManage(): void {
  open.value = false
  router.push('/pricing')
}
</script>

<template>
  <UPopover
    v-if="ownProviderOnly"
    v-model:open="open"
    :content="{ align: 'end', side: 'bottom', sideOffset: 8 }"
  >
    <button
      type="button"
      class="usage-badge hidden sm:flex items-center gap-1.5 pl-2.5 pr-3 py-1 rounded-full border border-default bg-default/60 backdrop-blur-sm transition-colors hover:bg-muted/40 text-xs text-muted cursor-pointer"
      data-testid="usage-badge-own-provider"
    >
      <UIcon
        name="i-lucide-key-round"
        class="size-3.5 shrink-0"
      />
      <span>{{ t('aiProvider.ownProviderBadge') }}</span>
    </button>

    <template #content>
      <div
        class="w-72 p-4 space-y-3"
        data-testid="usage-badge-own-provider-popover"
      >
        <h3 class="text-sm font-medium">
          {{ t('aiProvider.ownProviderBadge') }}
        </h3>
        <p class="text-xs text-muted leading-relaxed">
          {{ t('aiProvider.pointsOwnKeyHint') }}
          <NuxtLink
            to="/settings/ai"
            class="block mt-1 underline"
            data-testid="usage-badge-own-provider-settings"
            @click="open = false"
          >
            {{ t('topbar.ownProviderSettings') }}
          </NuxtLink>
        </p>
        <AuthUsageLimits
          v-if="billing"
          :billing="billing"
          class="border-t border-default pt-3"
        />
      </div>
    </template>
  </UPopover>
  <UPopover
    v-else-if="billing && anyPlatformBilled"
    v-model:open="open"
    :content="{ align: 'end', side: 'bottom', sideOffset: 8 }"
  >
    <button
      type="button"
      class="usage-badge hidden sm:flex items-center gap-2 pl-2.5 pr-3 py-1 rounded-full border border-default bg-default/60 backdrop-blur-sm transition-colors hover:bg-muted/40 cursor-pointer"
      :aria-label="t('credits.title')"
      data-testid="usage-badge"
    >
      <span
        v-if="billingEnabled"
        class="text-xs font-semibold uppercase tracking-wide text-muted"
      >
        {{ planLabel }}
      </span>
      <span class="usage-badge__bar-track relative h-1.5 w-20 rounded-full bg-muted/30 overflow-hidden">
        <span
          class="usage-badge__bar-fill absolute inset-y-0 left-0 transition-all"
          :class="barColor"
          :style="{ width: pctRemaining + '%' }"
        />
      </span>
      <span class="text-xs tabular-nums text-muted min-w-[2.25rem] text-right">
        {{ pctRemaining }}%
      </span>
    </button>

    <template #content>
      <div class="w-72 p-4 space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold">
            {{ t('topbar.creditsTooltipTitle') }}
          </h3>
          <UBadge
            v-if="billingEnabled"
            size="xs"
            variant="subtle"
            color="neutral"
          >
            {{ planLabel }}
          </UBadge>
        </div>

        <div>
          <div class="flex items-baseline justify-between text-xs text-muted mb-1">
            <span class="tabular-nums text-default font-medium">
              {{ pointsRemaining.toLocaleString(locale) }}
              <span class="text-muted font-normal">/ {{ pointsTotal.toLocaleString(locale) }}</span>
            </span>
            <span class="tabular-nums">{{ pctRemaining }}%</span>
          </div>
          <div class="relative h-2 w-full rounded-full bg-muted/30 overflow-hidden">
            <div
              class="absolute inset-y-0 left-0 transition-all"
              :class="barColor"
              :style="{ width: pctRemaining + '%' }"
            />
          </div>
        </div>

        <p
          v-if="isFreeAllowanceExhausted"
          class="text-xs text-warning leading-relaxed"
          data-testid="usage-badge-free-allowance-exhausted"
        >
          {{ t('ai.freeAllowanceExhausted') }}
          <NuxtLink
            to="/settings/ai"
            class="underline"
            @click="open = false"
          >
            {{ t('ai.freeAllowanceCta') }}
          </NuxtLink>
        </p>

        <div class="flex items-center gap-2 text-xs text-muted">
          <UIcon
            name="i-lucide-calendar"
            class="size-3.5 shrink-0"
          />
          <span>{{ t('topbar.creditsResetOn', { date: resetDate }) }}</span>
        </div>

        <div class="text-xs text-muted leading-relaxed border-t border-default pt-3">
          {{ t('topbar.creditsHint') }}
          <span
            v-if="usesOwnKey"
            class="block mt-1"
            data-testid="usage-badge-own-key-hint"
          >{{ t('aiProvider.pointsOwnKeyHint') }}</span>
        </div>

        <AuthUsageLimits
          :billing="billing"
          class="border-t border-default pt-3"
        />

        <div class="flex flex-col gap-2 pt-1">
          <UButton
            v-if="canUpgrade && nextPlan"
            block
            icon="i-lucide-arrow-up-circle"
            color="primary"
            @click="onUpgrade"
          >
            {{ t('topbar.upgradeToPlan', { plan: nextPlan.charAt(0).toUpperCase() + nextPlan.slice(1) }) }}
          </UButton>
          <p
            v-else-if="billingEnabled"
            class="text-xs text-center text-muted italic"
          >
            {{ t('topbar.topPlan') }}
          </p>
          <UButton
            v-if="billingEnabled || plansComingSoon"
            block
            variant="ghost"
            color="neutral"
            size="sm"
            data-testid="usage-badge-plans-link"
            @click="onManage"
          >
            {{ billingEnabled ? t('topbar.viewAllPlans') : t('billing.comingSoonCta') }}
          </UButton>
        </div>
      </div>
    </template>
  </UPopover>
</template>
