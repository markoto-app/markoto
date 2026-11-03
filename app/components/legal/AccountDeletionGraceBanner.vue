<script setup lang="ts">
// Persistent banner shown across the top of the app whenever the
// signed-in user's account is scheduled for deletion. Sumi-toned
// — this is a calm informational status, not an alarm. The cancel
// CTA is `neutral` (the brand never reaches for primary outside
// the AI seal).
//
// Visible until the deletion executes (at which point the user is
// gone and the session has been cleared, so this component never
// renders for an executed deletion). The /settings/profile page
// shows the same state with more context.

const { t } = useI18n()
const { status, refresh } = useAccountStatus()
const toast = useToast()

const cancelling = ref(false)

const showBanner = computed(() => status.value?.deletion?.pending === true)

const formattedDate = computed(() => {
  const grace = status.value?.deletion?.graceUntil
  if (!grace) return ''
  try {
    return new Date(grace).toLocaleString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  } catch {
    return grace
  }
})

// Compact variant for the mobile banner — just the date, no time.
// At 375px the long "Account scheduled for deletion — May 06, 2026,
// 12:00 PM" + a button breaks the single-line layout. We hide the
// title text on `<sm` and shorten the date so icon + date + cancel
// all fit on one row.
const formattedDateCompact = computed(() => {
  const grace = status.value?.deletion?.graceUntil
  if (!grace) return ''
  try {
    return new Date(grace).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric'
    })
  } catch {
    return grace
  }
})

async function onCancel(): Promise<void> {
  if (cancelling.value) return
  cancelling.value = true
  try {
    await $fetch('/api/user/delete-cancel', { method: 'POST' })
    await refresh()
    toast.add({
      title: t('legal.delete.cancelledToast'),
      description: '',
      icon: 'i-lucide-check',
      color: 'neutral'
    })
  } catch (e) {
    const err = e as { message?: string, data?: { message?: string } }
    toast.add({
      title: 'Could not cancel deletion',
      description: err.data?.message ?? err.message ?? 'Unknown error',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    cancelling.value = false
  }
}
</script>

<template>
  <output
    v-if="showBanner"
    class="grace-banner flex items-center justify-center gap-3 px-3 py-2 text-xs"
    data-testid="deletion-grace-banner"
  >
    <UIcon
      name="i-lucide-clock"
      class="size-4 shrink-0 text-muted"
    />
    <!-- Desktop: full status line with date+time. -->
    <span class="text-default hidden sm:inline">
      {{ t('legal.delete.graceBannerTitle') }} —
      <span class="font-mono">{{ formattedDate }}</span>
    </span>
    <!-- Mobile: compact date only — the title is implicit from the
         clock icon + the cancel CTA. Long status copy + a button at
         375px breaks the single-line banner. -->
    <span class="text-default sm:hidden font-mono">
      {{ formattedDateCompact }}
    </span>
    <UButton
      size="xs"
      color="neutral"
      variant="outline"
      :loading="cancelling"
      :ui="{ base: 'shrink-0' }"
      data-testid="grace-banner-cancel"
      @click="onCancel"
    >
      {{ t('legal.delete.graceBannerCancel') }}
    </UButton>
  </output>
</template>

<style scoped>
.grace-banner {
  background: var(--color-sumi-100, #f2efe7);
  border-bottom: 1px solid var(--color-sumi-200, #e5e1d4);
}
html.dark .grace-banner {
  /* Dark mode chrome resolves to flat sumi-950 (`bg-muted`); the
     banner needs to sit ABOVE that not just blend-mix into it.
     Step up to sumi-800 for a clearly-distinct strip + a
     hairline-bright bottom border for separation. */
  background: var(--color-sumi-800, #2c2925);
  border-bottom: 1px solid var(--color-sumi-700, #3a3631);
}
</style>
