import { formatTimeAgoIntl } from '@vueuse/core'

/**
 * "5 minutes ago" in the active UI language. `useTimeAgoIntl` takes its
 * locale once and falls back to the browser's, so a language switch (or a
 * browser set to another language than the UI) would not be followed; this
 * recomputes against `useI18n().locale` and a 30 s ticker.
 */
export function useRelativeTime(time: MaybeRefOrGetter<Date | number | string>): ComputedRef<string> {
  const { locale } = useI18n()
  const now = useNow({ scheduler: cb => useIntervalFn(cb, 30_000) })
  return computed(() => {
    const at = new Date(toValue(time))
    // A server clock a little ahead of this one must not read "in 8 seconds".
    const clamped = at.getTime() > now.value.getTime() ? now.value : at
    return formatTimeAgoIntl(clamped, { locale: locale.value }, now.value)
  })
}
