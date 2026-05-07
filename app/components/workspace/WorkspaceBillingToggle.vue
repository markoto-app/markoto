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
  <!-- The parent (workspace AI tab) provides the section header (icon
       + title + description). This component renders just the toggle
       row + per-state status lines, on the warm bone bg-default card
       so it sits cleanly inside the page chrome. The original gray-blue
       Tailwind palette read "third-party widget"; the new card uses
       the brand sumi neutrals. -->
  <div class="border border-default rounded-lg p-4 bg-default">
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
          on your plan · members see the editor banner
        </p>
        <div
          v-else-if="aiEnabled && !iAmBillingOwner"
          class="space-y-1.5"
        >
          <p class="font-mono text-[10.5px] tracking-[0.04em] text-muted lowercase">
            sponsored by another admin (user #{{ billingOwnerId }})
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
            Take over sponsorship
          </UButton>
        </div>
        <p
          v-else-if="!canEnable && !loadingBilling"
          class="font-mono text-[10.5px] tracking-[0.04em] text-muted lowercase inline-flex items-center gap-1.5"
        >
          <UIcon
            name="i-lucide-lock"
            class="size-3"
          />
          plan {{ billing?.plan ?? 'free' }} · upgrade to max or ultra to sponsor
        </p>
        <p
          v-else
          class="font-mono text-[10.5px] tracking-[0.04em] text-muted lowercase"
        >
          off · members use their own AI credits
        </p>
      </div>

      <USwitch
        :model-value="aiEnabled"
        :disabled="saving || loadingBilling || (!aiEnabled && !canEnable)"
        data-testid="workspace-ai-sponsoring-toggle"
        @update:model-value="(v: boolean) => setEnabled(v)"
      />
    </div>
  </div>
</template>
