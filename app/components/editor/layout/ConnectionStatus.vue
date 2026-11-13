<script setup lang="ts">
// Connection chips in the top bar: the sync status, only while something is
// wrong (reconnecting / disconnected), and the number of people here.
defineProps<{
  status: string
  userCount: number
}>()
const { t } = useI18n()
</script>

<template>
  <!-- Only shown when something is wrong: `connecting` (reconnect
       attempt) or `disconnected` (lost WS). Connected is the default. -->
  <span
    v-if="status !== 'connected'"
    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-default/70 bg-default font-mono text-[10.5px] tracking-[0.04em] text-muted lowercase"
    data-testid="connection-status"
    :data-status="status"
  >
    <span
      class="block size-1.5 rounded-full shrink-0"
      :class="{
        'bg-amber-500/80 dark:bg-amber-400/80 animate-pulse': status === 'connecting',
        'bg-rose-500/80 dark:bg-rose-400/80': status === 'disconnected'
      }"
      aria-hidden="true"
    />
    <span class="hidden sm:inline">{{ t(`status.${status}`) }}</span>
  </span>

  <!-- Calm chip like the status indicator; presence itself is shown by the colored avatar rings. -->
  <span
    v-if="userCount > 1"
    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-default/70 bg-default font-mono text-[10.5px] tracking-[0.04em] text-muted"
  >
    <UIcon
      name="i-lucide-users"
      class="size-3"
    />
    {{ userCount }}
  </span>
</template>
