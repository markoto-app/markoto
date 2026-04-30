<script setup lang="ts">
// Topbar usage badge. Shows the caller's plan name + a percentage bar
// of remaining AI credits in the current billing period. Colours:
//   ≥25% remaining → green
//   10-25%         → orange
//   <10%           → red
// Click-to-open popover with full breakdown + upgrade CTA. Chose a
// popover over a hover tooltip so the content can be richer (a real
// styled card, not a bare browser tooltip) and so the upgrade button
// is actually clickable without the tooltip disappearing.

import type { PlanName } from '~~/shared/config/tiers'

const { t, locale } = useI18n()
const router = useRouter()
const { billing } = useBilling()

const planLabel = computed(() => {
  const plan = billing.value?.plan ?? 'free'
  return plan.charAt(0).toUpperCase() + plan.slice(1)
})

// Pct-remaining drives both the bar width and the colour bucket.
// Guard against divide-by-zero: if limit is 0 (shouldn't happen but
// possible on a malformed response), show 0% so the user notices.
const pctRemaining = computed(() => {
  const b = billing.value
  if (!b || b.interactionsLimit <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((b.interactionsRemaining / b.interactionsLimit) * 100)))
})

const barColor = computed(() => {
  const pct = pctRemaining.value
  // Full-palette Tailwind classes so Tailwind's JIT picks them up at
  // build time — no dynamic string concatenation that would get
  // tree-shaken.
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

// The "upgrade" CTA only makes sense when there's a tier above us.
// Ultra users don't get a button that leads nowhere useful — we show
// a status line instead.
const PLAN_ORDER: readonly PlanName[] = ['free', 'pro', 'max', 'ultra']
const nextPlan = computed((): PlanName | null => {
  const plan = billing.value?.plan ?? 'free'
  const idx = PLAN_ORDER.indexOf(plan)
  if (idx < 0 || idx >= PLAN_ORDER.length - 1) return null
  return PLAN_ORDER[idx + 1]
})
const canUpgrade = computed(() => nextPlan.value !== null)

const open = ref(false)
const upgradeLoading = ref(false)

// Upgrade → direct checkout for the next tier up. Faster than
// bouncing through the pricing page when the user already knows what
// they want. "View all plans" is the escape hatch for browsing tiers.
async function onUpgrade(): Promise<void> {
  if (!nextPlan.value || upgradeLoading.value) return
  upgradeLoading.value = true
  try {
    const { url } = await $fetch<{ url: string }>('/api/billing/checkout', {
      method: 'POST',
      body: { plan: nextPlan.value }
    })
    window.location.href = url
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }

    console.warn('[usage-badge] checkout failed; routing to /pricing:', err)
    open.value = false
    router.push('/pricing')
  } finally {
    upgradeLoading.value = false
  }
}

function onManage(): void {
  open.value = false
  router.push('/pricing')
}
</script>

<template>
  <UPopover
    v-if="billing"
    v-model:open="open"
    :content="{ align: 'end', side: 'bottom', sideOffset: 8 }"
  >
    <button
      type="button"
      class="usage-badge hidden sm:flex items-center gap-2 pl-2.5 pr-3 py-1 rounded-full border border-default bg-default/60 backdrop-blur-sm transition-colors hover:bg-muted/40 cursor-pointer"
      aria-label="AI credits"
    >
      <span class="text-xs font-semibold uppercase tracking-wide text-muted">
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
        <!-- Header: plan + title -->
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold">
            {{ t('topbar.creditsTooltipTitle') }}
          </h3>
          <UBadge
            size="xs"
            variant="subtle"
            color="neutral"
          >
            {{ planLabel }}
          </UBadge>
        </div>

        <!-- Primary stat: remaining / limit + big bar -->
        <div>
          <div class="flex items-baseline justify-between text-xs text-muted mb-1">
            <span class="tabular-nums text-default font-medium">
              {{ billing.interactionsRemaining.toLocaleString() }}
              <span class="text-muted font-normal">/ {{ billing.interactionsLimit.toLocaleString() }}</span>
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

        <!-- Reset line -->
        <div class="flex items-center gap-2 text-xs text-muted">
          <UIcon
            name="i-lucide-calendar"
            class="size-3.5 shrink-0"
          />
          <span>{{ t('topbar.creditsResetOn', { date: resetDate }) }}</span>
        </div>

        <!-- Primer: what counts as a credit -->
        <div class="text-xs text-muted leading-relaxed border-t border-default pt-3">
          {{ t('topbar.creditsHint') }}
        </div>

        <!-- Actions -->
        <div class="flex flex-col gap-2 pt-1">
          <UButton
            v-if="canUpgrade && nextPlan"
            block
            icon="i-lucide-arrow-up-circle"
            color="primary"
            :loading="upgradeLoading"
            @click="onUpgrade"
          >
            {{ t('topbar.upgradeToPlan', { plan: nextPlan.charAt(0).toUpperCase() + nextPlan.slice(1) }) }}
          </UButton>
          <p
            v-else
            class="text-xs text-center text-muted italic"
          >
            {{ t('topbar.topPlan') }}
          </p>
          <UButton
            block
            variant="ghost"
            color="neutral"
            size="sm"
            @click="onManage"
          >
            {{ t('topbar.viewAllPlans') }}
          </UButton>
        </div>
      </div>
    </template>
  </UPopover>
</template>
