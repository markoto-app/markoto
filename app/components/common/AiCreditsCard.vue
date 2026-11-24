<script setup lang="ts">
import { TOPUP_PACKS, TOPUP_VALIDITY_MONTHS, type Currency, type TopupPackId } from '~~/shared/config/pricing'
import { formatPrice } from '~/utils/billing/pricing'
import { formatAiPoints } from '~/utils/billing/workspaceBilling'
import type { CreditBalanceView } from '~/utils/billing/aiCredits'

// Extra AI Points (top-ups): balance, the packs, and past purchases. The
// server keeps them in USD; the user only ever sees AI Points. Used
// on the profile page (personal, Pro) and the workspace billing tab (Team
// / Business). `workspaceId` picks the workspace's checkout route instead
// of the personal one; `canBuy` false shows
// `blockedReason` instead of the buy buttons.

const props = defineProps<{
  credits: CreditBalanceView | null
  currency: Currency
  workspaceId?: string
  canBuy: boolean
  blockedReason?: string
  testidPrefix: string
}>()

const { t, locale } = useI18n()
const { showError } = useErrorHandler()
// Top-ups switched off on this deployment: balance and past purchases only.
const { topupsEnabled } = useBillingMode()
const buyable = computed(() => props.canBuy && topupsEnabled.value)
const buying = ref<TopupPackId | null>(null)
// The Paid Plans Terms box: credits are usable at once, so the box
// also carries the consent that ends the withdrawal right on first use.
const paidTermsAccepted = ref(false)

async function buy(pack: TopupPackId) {
  if (!paidTermsAccepted.value) return
  buying.value = pack
  try {
    const body = { pack, currency: props.currency, acceptPaidTerms: true }
    const res = props.workspaceId
      ? await apiFetch('/api/workspaces/:wsId/billing/topup', { method: 'post', path: { wsId: props.workspaceId }, body })
      : await apiFetch('/api/billing/topup', { method: 'post', body })
    if (res.url) goToExternal(res.url)
  } catch (e) {
    showError('credits.buyFailed', e)
  } finally {
    buying.value = null
  }
}

function points(usd: number): string {
  return formatAiPoints(usd, locale.value)
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(locale.value, { year: 'numeric', month: 'short', day: 'numeric' })
}
</script>

<template>
  <div
    class="space-y-4"
    :data-testid="`${testidPrefix}-credits`"
  >
    <div class="flex items-baseline justify-between gap-3 flex-wrap">
      <p
        class="text-sm"
        :data-testid="`${testidPrefix}-credits-balance`"
      >
        {{ t('credits.balance', { points: points(credits?.usableUsd ?? 0) }) }}
      </p>
      <p
        v-if="credits && credits.usedThisMonthUsd > 0"
        class="font-mono text-[10.5px] tracking-[0.04em] text-muted"
      >
        {{ t('credits.usedThisMonth', { points: points(credits.usedThisMonthUsd) }) }}
      </p>
    </div>
    <p class="text-sm text-muted">
      {{ t('credits.explainer', { months: TOPUP_VALIDITY_MONTHS }) }}
    </p>

    <PricingPaidTermsConsent
      v-if="buyable"
      v-model="paidTermsAccepted"
      kind="topup"
      :testid="`${testidPrefix}-paid-terms`"
    />
    <div
      v-if="buyable"
      class="grid gap-2 sm:grid-cols-3"
    >
      <UButton
        v-for="pack in TOPUP_PACKS"
        :key="pack.id"
        color="neutral"
        variant="outline"
        block
        :disabled="!paidTermsAccepted"
        :loading="buying === pack.id"
        :data-testid="`${testidPrefix}-buy-${pack.id}`"
        @click="buy(pack.id)"
      >
        {{ t('credits.pack', { price: formatPrice(pack.price[currency], currency.toUpperCase(), locale), points: points(pack.creditUsd) }) }}
      </UButton>
    </div>
    <p
      v-else-if="blockedReason && topupsEnabled"
      class="text-sm text-muted"
    >
      {{ blockedReason }}
    </p>

    <ul
      v-if="credits && credits.grants.length > 0"
      class="divide-y divide-default border-t border-default text-xs"
    >
      <li
        v-for="(grant, i) in credits.grants"
        :key="i"
        class="py-2 flex justify-between gap-3 flex-wrap"
      >
        <span>{{ fmtDate(grant.createdAt) }} · {{ t('credits.points', { points: points(grant.amountUsd) }) }}</span>
        <span class="font-mono text-muted">
          {{ t('credits.grantLeft', { left: points(grant.remainingUsd), date: fmtDate(grant.expiresAt) }) }}
        </span>
      </li>
    </ul>
  </div>
</template>
