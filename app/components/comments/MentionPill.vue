<script setup lang="ts">
defineProps<{
  userId: number
  name: string
}>()
</script>

<template>
  <span
    class="inline-flex items-baseline rounded px-1 py-px text-xs font-medium bg-primary-500/15 text-primary-700 dark:bg-primary-400/20 dark:text-primary-300 align-baseline"
    :data-user-id="userId"
  >@{{ name }}</span>
</template>
