import { defaultCurrencyForLocale, type BillingInterval, type Currency } from '~~/shared/config/pricing'
import { MIN_WORKSPACE_SEATS } from '~~/shared/config/workspaceSeats'
import { withLoginReturn } from '~~/shared/utils/security/loginReturn'
import { PRICING_SELECTION_KEYS, pricingPathFor, pricingSelectionFromQuery, type PricingSelection } from '~/utils/billing/pricing'

/**
 * What the visitor looks at on the pricing page: billing period, currency,
 * and the Teams card's plan + seats. EUR on the server render; after mount
 * a Swiss browser locale (de-CH, fr-CH, …) switches to CHF. A link can
 * carry the choice (`?interval=year&currency=chf&plan=business&seats=5`):
 * the page a sign-in from here returns to does (`signInPath`), so signing
 * in keeps what was picked. Once applied, the address bar drops it again,
 * so a later toggle and a reload don't disagree.
 */
export function usePricingSelection() {
  const route = useRoute()
  const { primaryLoginPath } = useInstanceConfig()
  const linked = pricingSelectionFromQuery(route.query)
  const currency = ref<Currency>(linked.currency ?? 'eur')
  const interval = ref<BillingInterval>(linked.interval ?? 'month')
  const teamPlan = ref<'team' | 'business'>(linked.teamPlan ?? 'team')
  // Minimum 3, the smallest workspace subscription.
  const seats = ref(linked.seats ?? MIN_WORKSPACE_SEATS)

  /** What a plain `/pricing` shows this browser (EUR until mounted). */
  const localeCurrency = ref<Currency>('eur')
  const signInPath = computed(() => {
    if (!primaryLoginPath.value) return null
    const selection: PricingSelection = { interval: interval.value, currency: currency.value, teamPlan: teamPlan.value, seats: seats.value }
    const defaults: PricingSelection = { interval: 'month', currency: localeCurrency.value, teamPlan: 'team', seats: MIN_WORKSPACE_SEATS }
    return withLoginReturn(primaryLoginPath.value, pricingPathFor(route.path, selection, defaults))
  })

  onMounted(() => {
    localeCurrency.value = defaultCurrencyForLocale(globalThis.navigator?.language)
    if (!linked.currency) currency.value = localeCurrency.value
    const keys: readonly string[] = PRICING_SELECTION_KEYS
    if (Object.keys(route.query).some(key => keys.includes(key))) {
      const rest = Object.fromEntries(Object.entries(route.query).filter(([key]) => !keys.includes(key)))
      void navigateTo({ query: rest, hash: route.hash }, { replace: true })
    }
  })

  return { currency, interval, teamPlan, seats, signInPath }
}
