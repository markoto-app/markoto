<script setup lang="ts">
import type { TiersMap } from '~~/shared/config/tiers'

// Pricing option "Free account": the free plan's limits, and the way into it
// (sign in, or downgrade from a paid plan through the Customer Portal).
withDefaults(defineProps<{
  /** The viewer is on the free plan. */
  current: boolean
  /** The viewer pays for a plan and billing is on: downgrading goes through the portal. */
  canDowngrade: boolean
  portalLoading: boolean
  tiers: TiersMap
  /** Height reserved for the tagline, so the prices of one row line up. */
  taglineClass?: string
}>(), { taglineClass: 'lg:min-h-10' })
const emit = defineEmits<{ portal: [] }>()
const { t } = useI18n()
const { loggedIn } = useUserSession()
const { primaryLoginPath } = useInstanceConfig()
</script>

<template>
  <article
    :class="['relative rounded-lg border bg-default p-5 flex flex-col', current ? 'border-inverted' : 'border-default']"
    data-testid="pricing-tier-free"
    :data-current="current"
    data-coming-soon="false"
  >
    <div
      v-if="current"
      data-testid="pricing-current-plan-badge"
      class="absolute -top-3 left-5 bg-inverted text-inverted font-mono text-[10.5px] tracking-[0.06em] uppercase px-2.5 py-0.5 rounded-full"
    >
      {{ t('pricing.currentPlan') }}
    </div>
    <h2 class="font-serif text-xl font-normal tracking-tight">
      {{ t('pricing.freeAccount.title') }}
    </h2>
    <p :class="['text-sm text-muted mt-1', taglineClass]">
      {{ t('pricing.tiers.free') }}
    </p>
    <p class="mt-4 font-serif text-3xl font-light tracking-tight">
      {{ t('pricing.price.free') }}
    </p>
    <p class="font-mono text-[11px] uppercase tracking-[0.06em] text-muted mt-1">
      {{ t('pricing.availableNow') }}
    </p>
    <div class="mt-5 flex-1">
      <PricingCapsList
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
    </div>
    <div class="mt-6">
      <UButton
        v-if="current"
        disabled
        block
        color="neutral"
        variant="subtle"
      >
        {{ t('pricing.currentPlan') }}
      </UButton>
      <UButton
        v-else-if="canDowngrade"
        block
        color="neutral"
        variant="outline"
        :loading="portalLoading"
        @click="emit('portal')"
      >
        {{ t('pricing.downgrade') }}
      </UButton>
      <UButton
        v-else-if="!loggedIn && primaryLoginPath"
        :to="primaryLoginPath"
        external
        block
        color="neutral"
        variant="outline"
        data-testid="pricing-free-sign-in"
      >
        {{ t('pricing.freeAccount.signIn') }}
      </UButton>
    </div>
  </article>
</template>
