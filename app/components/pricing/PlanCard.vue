<script setup lang="ts">
// One of the three plan cards on /pricing (Free, Pro, Teams): the frame,
// the pill on top (current plan, else "coming soon"), title, tagline and
// price. The page fills the rest through slots: `switch` (the Team /
// Business switch), `price-extra` (the seat stepper), the default slot
// (the highlights) and `cta`.
defineProps<{
  title: string
  tagline: string
  price: string
  /** "per month", "per seat / year", …; empty for none. */
  unit: string
  /** Small line under the price ("Planned price", "Available now"). */
  priceNote: string
  current: boolean
  comingSoon: boolean
}>()
const { t } = useI18n()
</script>

<template>
  <article
    :class="[
      'relative rounded-lg border bg-default p-5 sm:p-6 flex flex-col min-w-0',
      current ? 'border-inverted' : 'border-default'
    ]"
  >
    <div
      v-if="current || comingSoon"
      :data-testid="current ? 'pricing-current-plan-badge' : 'pricing-coming-soon-badge'"
      class="absolute -top-3 left-5 bg-inverted text-inverted font-mono text-[10.5px] tracking-[0.06em] uppercase px-2.5 py-0.5 rounded-full"
    >
      {{ current ? t('pricing.currentPlan') : t('pricing.comingSoonBadge') }}
    </div>
    <div class="flex items-center justify-between gap-3 min-h-8">
      <h2 class="font-serif text-xl font-normal tracking-tight">
        {{ title }}
      </h2>
      <slot name="switch" />
    </div>
    <p class="text-sm text-muted mt-1 lg:min-h-10">
      {{ tagline }}
    </p>
    <div class="mt-4 flex items-baseline gap-1.5 flex-wrap">
      <span
        class="font-serif text-3xl font-light tracking-tight"
        data-testid="pricing-price"
      >{{ price }}</span>
      <span
        v-if="unit"
        class="text-sm text-muted"
      >{{ unit }}</span>
    </div>
    <p class="font-mono text-[11px] uppercase tracking-[0.06em] text-muted mt-1">
      {{ priceNote }}
    </p>
    <slot name="price-extra" />
    <div class="mt-5 flex-1">
      <slot />
    </div>
    <div class="mt-6">
      <slot name="cta" />
    </div>
  </article>
</template>
