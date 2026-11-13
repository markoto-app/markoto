<script setup lang="ts">
// Strip shown when `navigator.onLine === false`. Separate from the
// Hocuspocus connection status (`connecting` has many causes): this is the
// browser's own "no network" signal, so users can tell "wait for WiFi" from
// "the sync server is broken". Y.js edits keep queuing locally while offline;
// the banner only sets expectations.

const { t } = useI18n()
const online = useOnline()
</script>

<template>
  <div
    v-if="!online"
    role="status"
    class="offline-banner flex items-center justify-center gap-2 text-xs text-amber-900 dark:text-amber-100 px-3 py-1.5"
  >
    <UIcon
      name="i-lucide-wifi-off"
      class="size-4 shrink-0"
    />
    <span>{{ t('app.offline') }}</span>
  </div>
</template>

<style scoped>
.offline-banner {
  background: color-mix(in srgb, var(--color-amber-500, #f59e0b) 25%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--color-amber-500, #f59e0b) 40%, transparent);
}
</style>
