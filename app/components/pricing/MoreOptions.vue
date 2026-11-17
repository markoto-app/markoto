<script setup lang="ts">
import { TOPUP_PACKS, TOPUP_VALIDITY_MONTHS, type Currency } from '~~/shared/config/pricing'
import { selfHostPath } from '~~/shared/seo/marketing'

// The two lines under the plan cards: the extra AI Points packs (the
// details are in the FAQ; with billing on, a Pro viewer gets the way to
// buy them), then the ways in that need no plan: writing without an account, and
// self-hosting.
const props = defineProps<{
  currency: Currency
  /** Paid prices are planned, not on sale (billing off + coming soon). */
  planned: boolean
  /** Billing is on and the viewer can buy extra AI Points (Pro). */
  canBuy: boolean
}>()

const { t, locale } = useI18n()
const { marketingSite } = useInstanceConfig()

const packs = computed(() =>
  TOPUP_PACKS.map(pack => formatPrice(pack.price[props.currency], props.currency.toUpperCase(), locale.value)).join(' / ')
)
const selfHostLink = computed(() => selfHostPath(marketingSite.value))
const buyPointsRoute = BUY_AI_POINTS_ROUTE
</script>

<template>
  <div class="flex flex-col items-center gap-3 text-sm text-center">
    <p data-testid="pricing-credits">
      <CommonSeal
        :size="9"
        class="inline-block align-middle mr-2 -mt-0.5"
      />{{ t('pricing.creditsLine', { packs, months: TOPUP_VALIDITY_MONTHS }) }}
      <span
        v-if="planned"
        class="text-muted"
      >{{ t('pricing.price.plannedShort') }}</span>
      <NuxtLink
        v-else-if="canBuy"
        :to="buyPointsRoute"
        class="underline ml-1"
        data-testid="pricing-credits-buy-link"
      >{{ t('pricing.creditsBuyLink') }}</NuxtLink>
    </p>
    <p
      class="text-muted flex flex-wrap items-center justify-center gap-x-2 gap-y-1"
      data-testid="pricing-alt-links"
    >
      <MarketingStartButton
        :label="t('pricing.alt.anon')"
        variant="link"
        testid="pricing-anon-cta"
      />
      <span aria-hidden="true">·</span>
      <ULink
        :to="selfHostLink"
        class="underline text-default"
        data-testid="pricing-self-hosted-cta"
      >
        {{ t('pricing.alt.selfHost') }}
      </ULink>
    </p>
  </div>
</template>
