<script setup lang="ts">
import type { PlanName } from '~~/shared/config/tiers'

// "Sign up" on a paid plan while signed out: the same provider choice as the
// header's sign-in (AuthSignInModal), returning to the pricing page with the
// visitor's choice (`returnTo`, from usePricingSelection). Open while `plan`
// is set.
const props = defineProps<{
  plan: PlanName | null
  returnTo: string
}>()
const emit = defineEmits<{ 'update:plan': [PlanName | null] }>()
const { t } = useI18n()

const PLAN_LABELS: Record<PlanName, string> = { free: 'Free', pro: 'Pro', team: 'Team', business: 'Business' }

const open = computed({
  get: () => props.plan !== null,
  set: (v: boolean) => {
    if (!v) emit('update:plan', null)
  }
})
</script>

<template>
  <AuthSignInModal
    v-model:open="open"
    :title="t('pricing.signUpTitle', { plan: PLAN_LABELS[plan ?? 'pro'] })"
    :description="t('pricing.signUpDescription')"
    :return-to="returnTo"
  />
</template>
