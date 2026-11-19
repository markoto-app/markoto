<script setup lang="ts">
/**
 * Inline notice for a plan limit or a feature the current plan doesn't
 * include (server side: `server/utils/billing/entitlements.ts`). Every gated
 * control uses this one component so the wording and the link stay
 * consistent:
 *
 * - billing on → "Upgrade" link to /pricing,
 * - paid plans coming soon (hosted free-only) → "Paid plans coming soon",
 * - self-hosted → no link (the operator sets the limits; there is
 *   nothing to buy).
 *
 * TODO: members of a paid workspace get "Ask your
 * admin" instead of a purchase link.
 */
const props = defineProps<{
  /** i18n key of the sentence to show, e.g. `plan.feature.customCss`. */
  messageKey: string
  /** Optional i18n params for the sentence. */
  params?: Record<string, string | number>
}>()

const { t } = useI18n()
const { billingEnabled, plansComingSoon } = useBillingMode()
const marketingPath = useMarketingPath()

const linkLabel = computed(() => {
  if (billingEnabled.value) return t('ai.upgradeCta')
  if (plansComingSoon.value) return t('billing.comingSoonCta')
  return null
})
</script>

<template>
  <UAlert
    color="neutral"
    variant="subtle"
    icon="i-lucide-lock"
    :description="t(props.messageKey, props.params ?? {})"
    data-testid="plan-limit-notice"
  >
    <template
      v-if="linkLabel"
      #actions
    >
      <UButton
        :to="marketingPath('/pricing')"
        size="xs"
        color="neutral"
        variant="outline"
        :label="linkLabel"
        data-testid="plan-limit-notice-link"
      />
    </template>
  </UAlert>
</template>
