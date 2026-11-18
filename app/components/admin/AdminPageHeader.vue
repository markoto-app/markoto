<script setup lang="ts">
// Title block of an admin page: the title, one line of context and the
// page's actions (right of the title, under it on phones).
defineProps<{
  title: string
  intro?: string | null
}>()
</script>

<template>
  <header class="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 mb-6 sm:mb-8 print:mb-4">
    <div class="min-w-0">
      <h1 class="font-serif text-3xl sm:text-4xl font-normal tracking-tight text-default">
        {{ title }}
      </h1>
      <p
        v-if="intro"
        class="mt-2 text-sm text-muted max-w-2xl"
      >
        {{ intro }}
      </p>
      <slot name="meta" />
    </div>
    <div
      v-if="$slots.actions"
      class="flex flex-wrap items-center gap-2 print:hidden"
    >
      <slot name="actions" />
    </div>
  </header>
</template>
