import { formatTimeAgoIntl } from '@vueuse/core'

/**
 * "5 minutes ago" in the active UI language. `useTimeAgoIntl` takes its
 * locale once and falls back to the browser's, so a language switch (or a
 * browser set to another language than the UI) would not be followed; this
 * recomputes against `useI18n().locale` and a 30 s ticker.
 */
export function useRelativeTime(time: MaybeRefOrGetter<Date | number | string>): ComputedRef<string> {
  const { locale } = useI18n()
  const now = useNow({ interval: 30_000 })
  return computed(() => formatTimeAgoIntl(new Date(toValue(time)), { locale: locale.value }, now.value))
}
