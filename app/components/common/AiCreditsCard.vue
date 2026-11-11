<script setup lang="ts">
import { TOPUP_PACKS, TOPUP_VALIDITY_MONTHS, type Currency, type TopupPackId } from '~~/shared/config/pricing'
import { formatPrice } from '~/utils/billing/pricing'
import { formatUsd } from '~/utils/billing/workspaceBilling'
import type { CreditBalanceView } from '~/utils/billing/aiCredits'

// AI credit top-ups: balance, the packs, and past purchases. Used
// on the profile page (personal, Pro) and the workspace billing tab (Team
// / Business). `endpoint` is the checkout route; `canBuy` false shows
// `blockedReason` instead of the buy buttons.

const props = defineProps<{
  credits: CreditBalanceView | null
  currency: Currency
  endpoint: string
  canBuy: boolean
  blockedReason?: string
  testidPrefix: string
}>()

const { t, locale } = useI18n()
const { showError } = useErrorHandler()
const buying = ref<TopupPackId | null>(null)
// The Paid Plans Terms box: credits are usable at once, so the box
// also carries the consent that ends the withdrawal right on first use.
const paidTermsAccepted = ref(false)

async function buy(pack: TopupPackId) {
  if (!paidTermsAccepted.value) return
  buying.value = pack
  try {
    const res = await $fetch<{ url?: string }>(props.endpoint, { method: 'POST', body: { pack, currency: props.currency, acceptPaidTerms: true } })
    if (res.url) goToExternal(res.url)
  } catch (e) {
    showError('credits.buyFailed', e)
  } finally {
    buying.value = null
  }
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
      <p class="text-sm">
        {{ t('credits.balance', { amount: formatUsd(credits?.usableUsd ?? 0, locale) }) }}
      </p>
      <p
        v-if="credits && credits.usedThisMonthUsd > 0"
        class="font-mono text-[10.5px] tracking-[0.04em] text-muted"
      >
        {{ t('credits.usedThisMonth', { amount: formatUsd(credits.usedThisMonthUsd, locale) }) }}
      </p>
    </div>
    <p class="text-xs text-muted">
      {{ t('credits.explainer', { months: TOPUP_VALIDITY_MONTHS }) }}
    </p>

    <PricingPaidTermsConsent
      v-if="canBuy"
      v-model="paidTermsAccepted"
      kind="topup"
      :testid="`${testidPrefix}-paid-terms`"
    />
    <div
      v-if="canBuy"
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
        {{ t('credits.pack', { price: formatPrice(pack.price[currency], currency.toUpperCase(), locale), credit: formatUsd(pack.creditUsd, locale) }) }}
      </UButton>
    </div>
    <p
      v-else-if="blockedReason"
      class="text-xs text-muted"
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
        <span>{{ fmtDate(grant.createdAt) }} · {{ formatUsd(grant.amountUsd, locale) }}</span>
        <span class="font-mono text-muted">
          {{ t('credits.grantLeft', { left: formatUsd(grant.remainingUsd, locale), date: fmtDate(grant.expiresAt) }) }}
        </span>
      </li>
    </ul>
  </div>
</template>
