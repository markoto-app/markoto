// Test-only: report every error toast to the flow-test harness.
//
// Gated on `public.exposeTestHandles` (set only by the flow-test stack via
// NUXT_PUBLIC_EXPOSE_TEST_HANDLES=1). Nuxt UI renders no colour marker into
// the toast DOM, so the harness can't tell an error toast from an info toast
// by looking at the page. Instead the shared toast state is watched and each
// new `color: 'error'` toast goes to `window.__flowErrorToast`, installed by
// the Playwright fixture with `exposeBinding` (it survives navigations).
// Flows fail on any unexpected error toast (tests/e2e/fixtures/flow.ts).

type ReportedToast = { title: string, description: string }

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export default defineNuxtPlugin(() => {
  if (!useRuntimeConfig().public.exposeTestHandles) return

  const { toasts } = useToast()
  const reported = new Set<string | number>()

  watch(toasts, (list) => {
    for (const toast of list) {
      if (toast.color !== 'error' || toast.id === undefined || reported.has(toast.id)) continue
      reported.add(toast.id)
      const report: unknown = Reflect.get(globalThis, '__flowErrorToast')
      if (typeof report === 'function') {
        const payload: ReportedToast = { title: textOf(toast.title), description: textOf(toast.description) }
        Promise.resolve(report(payload)).catch(() => {})
      }
    }
  }, { deep: true, immediate: true })
})
