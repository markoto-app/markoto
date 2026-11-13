<script setup lang="ts">
// The box every purchase needs: accepts the Paid Plans Terms
// (/legal/paid-terms) and, for EU consumers, asks for the immediate start
// that the withdrawal rules hinge on (terms §6). `kind` picks the sentence:
// a plan starts at once, AI credits are usable at once. The parent sends
// `acceptPaidTerms: true` with the purchase and keeps its buy buttons
// disabled while the box is unticked. The server refuses a purchase
// without it (400 `billing/terms-required`).
withDefaults(defineProps<{
  kind: 'plan' | 'topup'
  testid?: string
}>(), { testid: 'paid-terms-consent' })

const accepted = defineModel<boolean>({ default: false })
const { t } = useI18n()
</script>

<template>
  <!-- The testid sits on a wrapper: on UCheckbox it lands on the box
       button, and tests need the label too. -->
  <div :data-testid="testid">
    <UCheckbox
      v-model="accepted"
      :ui="{ label: 'font-normal text-xs text-muted', description: 'text-xs' }"
    >
      <template #label>
        <i18n-t
          :keypath="kind === 'topup' ? 'billing.paidTerms.consentTopup' : 'billing.paidTerms.consentPlan'"
          scope="global"
        >
          <template #terms>
            <NuxtLink
              to="/legal/paid-terms"
              target="_blank"
              class="underline"
              @click.stop
            >{{ t('billing.paidTerms.link') }}</NuxtLink>
          </template>
        </i18n-t>
      </template>
    </UCheckbox>
  </div>
</template>
