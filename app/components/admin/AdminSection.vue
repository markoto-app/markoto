<script setup lang="ts">
// One titled group on an admin page: a small header (title, optional
// note, optional actions) over its tiles, charts or tables. `pageBreak`
// starts the section on a new printed page.
withDefaults(defineProps<{
  title?: string | null
  note?: string | null
  pageBreak?: boolean
}>(), { title: null, note: null, pageBreak: false })
</script>

<template>
  <section
    class="space-y-3"
    :class="pageBreak ? 'print:break-before-page' : ''"
    data-testid="admin-section"
  >
    <div
      v-if="title || $slots.actions"
      class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
    >
      <div class="min-w-0">
        <h2
          v-if="title"
          class="font-mono text-[11px] uppercase tracking-wider text-muted"
        >
          {{ title }}
        </h2>
        <p
          v-if="note"
          class="mt-1 text-xs text-muted"
        >
          {{ note }}
        </p>
      </div>
      <div
        v-if="$slots.actions"
        class="print:hidden"
      >
        <slot name="actions" />
      </div>
    </div>
    <slot />
  </section>
</template>
