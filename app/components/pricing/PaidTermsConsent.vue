<script setup lang="ts">
// The box every purchase needs: accepts the Paid Plans Terms
// (/legal/paid-terms) and, for EU consumers, asks for the immediate start
// that the withdrawal rules hinge on (terms §6). `kind` picks the sentence:
// a plan starts at once, AI credits are usable at once. The parent sends
// `acceptPaidTerms: true` with the purchase and keeps its buy buttons
// disabled while the box is unticked. The server refuses a purchase
// without it (400 `billing/terms-required`). `size` matches the help text
// around it: `sm` on the profile and in the AI Points card, `xs` next to
// smaller notes (pricing plan cards, the workspace seat controls).
const props = withDefaults(defineProps<{
  kind: 'plan' | 'topup'
  testid?: string
  size?: 'xs' | 'sm'
}>(), { testid: 'paid-terms-consent', size: 'sm' })

const accepted = defineModel<boolean>({ default: false })
// Full class names so Tailwind sees them.
const textClass = computed(() => props.size === 'xs' ? 'text-xs' : 'text-sm')
const { t } = useI18n()
</script>

<template>
  <!-- The testid sits on a wrapper: on UCheckbox it lands on the box
       button, and tests need the label too. -->
  <div :data-testid="testid">
    <UCheckbox
      v-model="accepted"
      :ui="{ label: `font-normal ${textClass} text-muted`, description: textClass }"
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
