<script setup lang="ts">
// Live "X ago" timestamp wrapper for v-for rows where each item needs
// its own ticker. `useTimeAgoIntl` can't be called inside a loop in
// the parent — Vue composables only run during setup — so this thin
// component owns one composable instance per timestamp.
//
// Uses Intl.RelativeTimeFormat in the active UI language ("5 minutes ago" /
// "vor 5 Minuten" / "il y a 5 minutes") without per-locale i18n keys.
//
// The absolute time appears as a tooltip via `title` so users can
// still see the precise timestamp on hover.

const props = defineProps<{
  ts: string | number | Date
}>()

const { locale } = useI18n()
const date = computed(() => new Date(props.ts))
const relative = useRelativeTime(date)

const absoluteTitle = computed(() => {
  const d = date.value
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
})
</script>

<template>
  <span :title="absoluteTitle">{{ relative }}</span>
</template>
