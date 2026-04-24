<script setup lang="ts">
// (+) team-billing toggle. Admin-only. Enabling requires the caller's
// account to be on Max or Ultra; the server enforces this, but we
// mirror the check in the UI so the toggle is visibly disabled for
// Free/Pro admins instead of showing a 403 on click.
//
// The component fetches the caller's plan via `/api/user/billing` at
// mount via `/api/user/billing` which is session-level (no workspace
// context needed).

interface UserBilling {
  plan: 'free' | 'pro' | 'max' | 'ultra'
  interactionsRemaining: number
  interactionsLimit: number
  periodStart: string
}

const props = defineProps<{
  workspaceId: string
  aiEnabled: boolean
  billingOwnerId: number | null
}>()
const emit = defineEmits<{ (e: 'updated'): void }>()

const toast = useToast()
const { user } = useUserSession()
const myUserId = computed(() => (user.value as { id?: number })?.id)

const billing = ref<UserBilling | null>(null)
const loadingBilling = ref(true)
onMounted(async () => {
  try {
    billing.value = await $fetch<UserBilling>('/api/user/billing')
  } catch (e) {
    // Non-fatal — the toggle just renders disabled. The caller can
    // still see the current (+) state; they just can't change it
    // without the billing fetch.
    console.warn('[billing-toggle] could not load /api/user/billing', e)
  } finally {
    loadingBilling.value = false
  }
})

const canEnable = computed(() =>
  billing.value?.plan === 'max' || billing.value?.plan === 'ultra'
)
const iAmBillingOwner = computed(() =>
  props.aiEnabled && props.billingOwnerId === myUserId.value
)

const saving = ref(false)

async function setEnabled(next: boolean) {
  if (saving.value) return
  saving.value = true
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/billing`, {
      method: 'PATCH',
      body: { aiEnabled: next }
    })
    emit('updated')
    toast.add({
      title: next ? 'AI workspace enabled' : 'AI workspace disabled',
      description: next
        ? 'Members\' AI use in this workspace is now sponsored by your plan.'
        : 'Members are back to using their own AI credits.',
      icon: 'i-lucide-check',
      color: 'success'
    })
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: 'Could not update AI workspace',
      description: err?.data?.message || err?.message || 'Unknown error',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-800/50">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <UIcon name="i-lucide-sparkles" class="text-orange-600 dark:text-orange-400" />
          AI workspace
        </h3>
        <p class="mt-1 text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
          Turn this workspace into an AI workspace: every member's AI use in any
          document here is billed to your plan's credit pool, so the whole team
          can work with AI without each person needing their own paid plan.
          Requires Max or Ultra.
        </p>

        <!-- State indicators -->
        <p v-if="aiEnabled && iAmBillingOwner" class="mt-2 text-xs text-orange-700 dark:text-orange-300">
          <UIcon name="i-lucide-info" class="inline mr-1" />
          This is an AI workspace on your plan. Members see a banner in the editor.
        </p>
        <p v-else-if="aiEnabled && !iAmBillingOwner" class="mt-2 text-xs text-gray-600 dark:text-gray-400">
          <UIcon name="i-lucide-user" class="inline mr-1" />
          AI for this workspace is sponsored by another admin (user #{{ billingOwnerId }}). Turn this off and on again to sponsor it yourself.
        </p>
        <p v-else-if="!canEnable && !loadingBilling" class="mt-2 text-xs text-gray-500 dark:text-gray-400">
          <UIcon name="i-lucide-lock" class="inline mr-1" />
          Your current plan ({{ billing?.plan ?? 'free' }}) can't sponsor an AI workspace. Upgrade to Max or Ultra.
        </p>
      </div>

      <USwitch
        :model-value="aiEnabled"
        :disabled="saving || loadingBilling || (!aiEnabled && !canEnable)"
        @update:model-value="(v: boolean) => setEnabled(v)"
      />
    </div>
  </div>
</template>
