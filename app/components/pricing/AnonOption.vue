<script setup lang="ts">
import { formatCount } from '~/utils/billing/pricing'

// Pricing option "No account": write and export without signing up; no AI,
// and the document is deleted after the instance's retention.
const { t, locale } = useI18n()
const { anonDocTtlDays } = useInstanceConfig()
</script>

<template>
  <article
    class="relative rounded-lg border bg-default p-5 flex flex-col border-default"
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
</template>
