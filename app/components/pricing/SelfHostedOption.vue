<script setup lang="ts">
// Pricing option "Self-hosted": every feature on your own server, free.
const { t } = useI18n()
</script>

<template>
  <article
    class="relative rounded-lg border bg-default p-5 flex flex-col border-default"
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
      to="/docs/self-hosting"
      color="neutral"
      variant="outline"
      block
      class="mt-6"
      data-testid="pricing-self-hosted-cta"
    >
      {{ t('pricing.selfHosted.cta') }}
    </UButton>
  </article>
</template>
