import { BILLING_DISABLED_MODE, resolveBillingMode, type BillingMode } from '~~/shared/config/billingMode'

/**
 * The deployment's billing mode on the client (see
 * `shared/config/billingMode.ts` for the deployment matrix).
 *
 * Resolved ONCE on the server from `NUXT_BILLING_ENABLED` /
 * `NUXT_PLANS_COMING_SOON` — the exact same parser the server-side
 * guards use, so UI and API can never disagree — and shipped to the
 * browser through the SSR payload (`useState`). The
 * `app/plugins/billing-mode.ts` plugin touches it during every SSR pass
 * so the state is hydrated even on pages that don't read it at render
 * time. Defaults to "billing off" on the client, which hides purchase
 * surfaces rather than showing dead ones.
 */
export function useBillingMode() {
  const mode = useState<BillingMode>('billing-mode', () =>
    import.meta.server ? resolveBillingMode(process.env) : { ...BILLING_DISABLED_MODE }
  )
  const billingEnabled = computed(() => mode.value.billingEnabled)
  const plansComingSoon = computed(() => mode.value.plansComingSoon)
  // Whether linking to /pricing makes sense at all: either there's a
  // plan to buy, or the hosted SaaS advertises upcoming plans + waitlist.
  const pricingVisible = computed(() => billingEnabled.value || plansComingSoon.value)
  return { mode, billingEnabled, plansComingSoon, pricingVisible }
}
