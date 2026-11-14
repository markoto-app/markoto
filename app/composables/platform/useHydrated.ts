/**
 * False during the server render and until the calling component has
 * hydrated, then true. A server-rendered button has no click handler
 * before hydration, so a click in that window is lost without a trace;
 * bind `:disabled="!hydrated"` to make the wait visible instead. Server
 * render and first client render agree (false), so there is no mismatch.
 */
export function useHydrated(): Readonly<Ref<boolean>> {
  const hydrated = ref(false)
  onMounted(() => {
    hydrated.value = true
  })
  return readonly(hydrated)
}
