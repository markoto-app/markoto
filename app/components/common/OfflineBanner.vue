<script setup lang="ts">
// Yellow status strip shown across the top of the app when the
// browser reports `navigator.onLine === false`. Distinct from the
// Hocuspocus connection status (which can be `connecting` for many
// reasons — server down, JWT expired, rate-limited) — this is the
// browser's own "you have no network" signal. The split lets users
// distinguish "wait for WiFi" from "the sync server is broken".
//
// Y.js still works locally while offline (CRDT edits queue in the
// browser); this banner just sets expectations so the user doesn't
// think their changes are landing on the server.

const { t } = useI18n()
const online = useOnline()
</script>

<template>
  <div
    v-if="!online"
    class="offline-banner flex items-center justify-center gap-2 text-xs text-amber-900 dark:text-amber-100 px-3 py-1.5"
    role="status"
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
