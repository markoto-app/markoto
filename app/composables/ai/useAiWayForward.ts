import { AI_SETTINGS_ROUTE, useAiWorkspaceContext } from './useAiAvailability'
import { BUY_AI_POINTS_ROUTE } from './useAiCredits'

export interface WayForwardAction {
  label: string
  color: 'primary' | 'neutral'
  onClick: () => void
}

/**
 * The ways forward when the user's personal AI budget is used up, for
 * notices outside the prompt bar (dictation, the comment trigger, design
 * import). With billing on: "Upgrade" (Free) or "Buy AI Points" (Pro, the
 * top personal plan); paid plans coming soon: the coming-soon page;
 * self-hosted: nothing to buy. Inside a workspace document the workspace's
 * admins decide, so no purchase is offered. Their own provider key always
 * works, so "Add your own key" comes last in every case.
 */
export function useAiWayForward() {
  const { t } = useI18n()
  const router = useRouter()
  const marketingPath = useMarketingPath()
  const { billingEnabled, plansComingSoon } = useBillingMode()
  const { billing } = useBilling()
  const workspace = useAiWorkspaceContext()

  function goToPricing(): void {
    globalThis.location.href = marketingPath('/pricing')
  }

  function ownKeyAction(): WayForwardAction {
    return { label: t('ai.freeAllowanceCta'), color: 'neutral', onClick: () => void router.push(AI_SETTINGS_ROUTE) }
  }

  /** The purchase that gives more AI, or null when there is none to offer here. */
  function purchaseAction(): WayForwardAction | null {
    if (workspace.value) return null
    if (billingEnabled.value) {
      if (billing.value?.plan === 'pro') return { label: t('ai.buyPointsCta'), color: 'neutral', onClick: () => void router.push(BUY_AI_POINTS_ROUTE) }
      return { label: t('ai.upgradeCta'), color: 'primary', onClick: goToPricing }
    }
    if (plansComingSoon.value) return { label: t('billing.comingSoonCta'), color: 'neutral', onClick: goToPricing }
    return null
  }

  /** Every way forward for a used-up personal budget, purchase first. */
  function budgetActions(): WayForwardAction[] {
    const purchase = purchaseAction()
    return purchase ? [purchase, ownKeyAction()] : [ownKeyAction()]
  }

  /** The sentence that goes with `budgetActions()`. */
  function budgetDescription(): string {
    if (workspace.value) return t('ai.workspaceBudgetExhaustedDescription')
    if (billingEnabled.value) return t(billing.value?.plan === 'pro' ? 'ai.budgetExhaustedProDescription' : 'ai.budgetExhaustedDescription')
    return t(plansComingSoon.value ? 'ai.budgetExhaustedComingSoonDescription' : 'ai.budgetExhaustedResetDescription')
  }

  return { budgetActions, budgetDescription, purchaseAction, ownKeyAction }
}
