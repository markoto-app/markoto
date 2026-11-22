<script setup lang="ts">
// Placeholder rows for the explorer's first fetch: the list is not empty,
// it has not arrived yet.
const { t } = useI18n()
</script>

<template>
  <div
    class="py-3 space-y-3"
    role="status"
    :aria-label="t('common.loading')"
    data-testid="explorer-skeleton"
  >
    <div
      v-for="n in 5"
      :key="n"
      class="flex items-center gap-3 px-2"
    >
      <USkeleton class="size-5 rounded" />
      <USkeleton class="h-4 flex-1 max-w-72" />
      <USkeleton class="hidden sm:block h-4 w-20" />
    </div>
  </div>
</template>
