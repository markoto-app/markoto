<script setup lang="ts">
// Live "X ago" timestamp wrapper for v-for rows where each item needs
// its own ticker. `useTimeAgoIntl` can't be called inside a loop in
// the parent — Vue composables only run during setup — so this thin
// component owns one composable instance per timestamp.
//
// Uses Intl.RelativeTimeFormat under the hood so the output is
// locale-aware out of the box ("5 minutes ago" / "vor 5 Minuten" /
// "il y a 5 minutes") without per-locale i18n keys.
//
// The absolute time appears as a tooltip via `title` so users can
// still see the precise timestamp on hover.

const props = defineProps<{
  ts: string | number | Date
}>()

const date = computed(() => new Date(props.ts))
const relative = useTimeAgoIntl(date)

const absoluteTitle = computed(() => {
  const d = date.value
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
})
</script>

<template>
  <span :title="absoluteTitle">{{ relative }}</span>
</template>
