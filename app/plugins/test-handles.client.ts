// Test-only: report every error toast to the flow-test harness.
//
// Gated on `public.exposeTestHandles` (false in production builds; the
// flow-test stack flips it via NUXT_PUBLIC_EXPOSE_TEST_HANDLES=1, see
// scripts/flows-ephemeral.ts). Nuxt UI renders no colour marker into the
// toast DOM, so the harness can't tell an error toast from an info toast
// by looking at the page. Instead we watch the shared toast state and
// hand each new `color: 'error'` toast to `window.__flowErrorToast`,
// which the Playwright fixture installs with `exposeBinding` (it
// survives navigations). Flows fail on any error toast they didn't
// explicitly expect — see tests/e2e/fixtures/flow.ts.

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
