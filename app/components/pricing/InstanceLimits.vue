<script setup lang="ts">
import type { TiersMap } from '~~/shared/config/tiers'

// /pricing on an instance that sells no plans (billing off, not "coming
// soon": a self-hosted instance): the limits every account gets.
defineProps<{
  tiers: TiersMap
  current: boolean
}>()
const { t } = useI18n()
</script>

<template>
  <div>
    <article
      class="relative rounded-lg border bg-default p-5 flex flex-col border-default max-w-sm mx-auto"
      data-testid="pricing-tier-free"
      :data-current="current"
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
        :tiers="tiers"
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
  </div>
</template>
