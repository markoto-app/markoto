<script setup lang="ts">
import type { PlanName } from '~~/shared/config/tiers'
import { sponsorshipAvailability } from '~~/shared/config/sponsorship'

// (+) team-billing toggle. Admin-only. Enabling requires the caller's
// account to be on Max or Ultra; the server enforces this, but we
// mirror the check in the UI so the toggle is visibly disabled — with a
// note and a link to /pricing — instead of showing a 403 on click.
//
// Billing modes (`sponsorshipAvailability`):
//   - billing on: the plan decides (fetched from `/api/user/billing`).
//   - billing off + plans coming soon (hosted free SaaS): shown
//     disabled with "coming with paid plans". The switch never calls the
//     billing endpoint in this mode (the server would 404 anyway).
//   - self-hosted: the page doesn't render this component at all.

interface UserBilling {
  plan: PlanName
  periodStart: string
}

const props = defineProps<{
  workspaceId: string
  aiEnabled: boolean
  billingOwnerId: number | null
}>()
const emit = defineEmits<{ (e: 'updated'): void }>()

const { t } = useI18n()
const toast = useToast()
const { user } = useUserSession()
const myUserId = computed(() => user.value?.id)
const { mode, billingEnabled } = useBillingMode()

const billing = ref<UserBilling | null>(null)
const billingFailed = ref(false)
onMounted(async () => {
  // Nothing to look up while billing is off — no plan can sponsor.
  if (!billingEnabled.value) return
  try {
    billing.value = await $fetch<UserBilling>('/api/user/billing')
  } catch (e) {
    // Non-fatal — the toggle renders as "needs upgrade" (disabled). The
    // caller can still see the current (+) state.
    console.warn('[billing-toggle] could not load /api/user/billing', e)
    billingFailed.value = true
  }
})

const availability = computed(() => {
  const plan = billing.value?.plan ?? (billingFailed.value ? 'free' : null)
  return sponsorshipAvailability(mode.value, plan)
})
const canEnable = computed(() => availability.value === 'available')
const iAmBillingOwner = computed(() =>
  props.aiEnabled && props.billingOwnerId === myUserId.value
)
const planLabel = computed(() => {
  const plan = billing.value?.plan ?? 'free'
  return plan.charAt(0).toUpperCase() + plan.slice(1)
})

const saving = ref(false)

async function setEnabled(next: boolean) {
  // Defence in depth: the switch is disabled in these states, but a
  // disabled control must never reach the billing endpoint.
  if (saving.value || !billingEnabled.value) return
  if (next && !canEnable.value) return
  saving.value = true
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/billing`, {
      method: 'PATCH',
      body: { aiEnabled: next }
    })
    emit('updated')
    toast.add({
      title: next ? t('workspace.sponsorship.enabledToast') : t('workspace.sponsorship.disabledToast'),
      description: next ? t('workspace.sponsorship.enabledToastDescription') : t('workspace.sponsorship.disabledToastDescription'),
      icon: 'i-lucide-check',
      color: 'success'
    })
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: t('workspace.sponsorship.updateFailed'),
      description: err?.data?.message || err?.message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <!-- The parent (workspace AI tab) provides the section header (icon
       + title + description). This component renders just the toggle
       row + per-state status lines, on the bg-default card. -->
  <div
    class="border border-default rounded-lg p-4 bg-default"
    :data-sponsorship-state="availability"
    data-testid="workspace-ai-sponsoring"
  >
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0 space-y-2">
        <p
          v-if="aiEnabled && iAmBillingOwner"
          class="font-mono text-[10.5px] tracking-[0.04em] text-muted lowercase inline-flex items-center gap-1.5"
        >
          <span
            class="block size-1.5 rounded-full bg-shu-500 dark:bg-shu-400"
            aria-hidden="true"
          />
          {{ t('workspace.sponsorship.onYourPlan') }}
        </p>
        <div
          v-else-if="aiEnabled && !iAmBillingOwner"
          class="space-y-1.5"
        >
          <p class="font-mono text-[10.5px] tracking-[0.04em] text-muted lowercase">
            {{ t('workspace.sponsorship.sponsoredByOther') }}
          </p>
          <UButton
            v-if="canEnable"
            size="xs"
            color="neutral"
            variant="subtle"
            icon="i-lucide-arrow-left-right"
            :loading="saving"
            data-testid="workspace-ai-takeover"
            @click="setEnabled(true)"
          >
            {{ t('workspace.sponsorship.takeOver') }}
          </UButton>
        </div>
        <!-- Not available to this account: say why, and where to go. -->
        <div
          v-else-if="availability === 'needsUpgrade' || availability === 'comingSoon'"
          class="space-y-1"
          data-testid="workspace-ai-sponsoring-locked"
        >
          <p class="text-sm text-muted inline-flex items-center gap-1.5">
            <UIcon
              name="i-lucide-lock"
              class="size-3.5 shrink-0"
            />
            {{ availability === 'comingSoon'
              ? t('workspace.sponsorship.comingSoon')
              : t('workspace.sponsorship.needsUpgrade', { plan: planLabel }) }}
          </p>
          <ULink
            to="/pricing"
            class="text-sm text-default underline underline-offset-2"
            data-testid="workspace-ai-sponsoring-pricing"
          >
            {{ availability === 'comingSoon' ? t('workspace.sponsorship.seePlans') : t('workspace.sponsorship.upgrade') }}
          </ULink>
        </div>
        <p
          v-else
          class="font-mono text-[10.5px] tracking-[0.04em] text-muted lowercase"
        >
          {{ t('workspace.sponsorship.off') }}
        </p>
      </div>

      <USwitch
        :model-value="aiEnabled"
        :disabled="saving || availability === 'loading' || availability === 'comingSoon' || (!aiEnabled && !canEnable)"
        :aria-label="t('workspace.sponsorship.toggleLabel')"
        data-testid="workspace-ai-sponsoring-toggle"
        @update:model-value="(v: boolean) => setEnabled(v)"
      />
    </div>
  </div>
</template>
