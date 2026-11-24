import { BILLING_DISABLED_MODE, resolveBillingMode, type BillingMode } from '~~/shared/config/billingMode'

/**
 * The deployment's billing mode on the client (see
 * `shared/config/billingMode.ts` for the deployment matrix).
 *
 * Resolved once on the server from `NUXT_BILLING_ENABLED` /
 * `NUXT_PLANS_COMING_SOON` with the same parser the server-side guards
 * use, so UI and API can't disagree, and shipped through the SSR payload
 * (`useState`). `app/plugins/billing-mode.ts` touches it on every SSR pass
 * so it is hydrated even on pages that don't read it at render time.
 * Defaults to "billing off" on the client, hiding purchase surfaces.
 */
export function useBillingMode() {
  const mode = useState<BillingMode>('billing-mode', () =>
    import.meta.server ? resolveBillingMode(process.env) : { ...BILLING_DISABLED_MODE }
  )
  const billingEnabled = computed(() => mode.value.billingEnabled)
  const plansComingSoon = computed(() => mode.value.plansComingSoon)
  const managedPayments = computed(() => mode.value.managedPayments === true)
  // /pricing is worth linking when there is a plan to buy or upcoming plans + waitlist.
  const pricingVisible = computed(() => billingEnabled.value || plansComingSoon.value)
  // AI credit top-ups are offered on this deployment (`NUXT_BILLING_TOPUPS_ENABLED`);
  // `canBuyTopups` adds that billing is on, so they can be bought now.
  const topupsEnabled = computed(() => mode.value.topupsEnabled !== false)
  const canBuyTopups = computed(() => billingEnabled.value && topupsEnabled.value)
  return { mode, billingEnabled, plansComingSoon, managedPayments, pricingVisible, topupsEnabled, canBuyTopups }
}
