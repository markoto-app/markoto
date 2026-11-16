<script setup lang="ts">
import type { BillingInterval } from '~~/shared/config/pricing'
import { useResumeProPlan, useSwitchProInterval } from '~/queries/billing'

// Profile → Spending, under a Pro plan: switch between monthly and annual
// billing (the server swaps the price on the live subscription; like every
// purchase it needs the Paid Plans Terms box). A plan cancelled in the
// portal that still runs offers only "Resume plan": it renews again.
const props = defineProps<{
  interval: BillingInterval
  /** Set when the plan was cancelled: it ends then instead of renewing. */
  cancelAt: string | null
}>()

const { t } = useI18n()
const toast = useToast()
const { showError } = useErrorHandler()

const switchInterval = useSwitchProInterval()
const paidTermsAccepted = ref(false)
async function onSwitchInterval(): Promise<void> {
  if (!paidTermsAccepted.value) return
  try {
    const res = await switchInterval.mutateAsync(props.interval === 'month' ? 'year' : 'month')
    if ('updated' in res) {
      // The consent covered this change only; the next one asks again.
      paidTermsAccepted.value = false
      toast.add({ title: t('workspace.billing.planChanged'), icon: 'i-lucide-check', color: 'neutral' })
    } else if (res.url) {
      // No live subscription after all: the server opened a Checkout.
      goToExternal(res.url)
    }
  } catch (e) {
    showError('workspace.billing.planChangeFailed', e)
  }
}

const resumePlan = useResumeProPlan()
async function onResumePlan(): Promise<void> {
  try {
    await resumePlan.mutateAsync()
    toast.add({ title: t('workspace.billing.resumed'), icon: 'i-lucide-check', color: 'neutral' })
  } catch (e) {
    showError('workspace.billing.resumeFailed', e)
  }
}
</script>

<template>
  <div
    v-if="cancelAt"
    class="flex gap-2 flex-wrap border-t border-default pt-4"
  >
    <UButton
      color="neutral"
      size="sm"
      icon="i-lucide-rotate-ccw"
      :loading="resumePlan.isLoading.value"
      data-testid="profile-resume-plan"
      @click="onResumePlan"
    >
      {{ t('workspace.billing.resume') }}
    </UButton>
  </div>
  <div
    v-else
    class="flex gap-2 flex-wrap border-t border-default pt-4"
    data-testid="profile-interval-switch"
  >
    <PricingPaidTermsConsent
      v-model="paidTermsAccepted"
      kind="plan"
      class="basis-full"
      testid="profile-switch-paid-terms"
    />
    <UButton
      color="neutral"
      variant="ghost"
      size="sm"
      :disabled="!paidTermsAccepted"
      :loading="switchInterval.isLoading.value"
      data-testid="profile-switch-interval"
      @click="onSwitchInterval"
    >
      {{ interval === 'month' ? t('workspace.billing.switchToAnnual') : t('workspace.billing.switchToMonthly') }}
    </UButton>
  </div>
</template>
