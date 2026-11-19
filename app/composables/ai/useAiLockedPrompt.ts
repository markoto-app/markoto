import { AI_SETTINGS_ROUTE, useAiWorkspaceContext } from './useAiAvailability'

/**
 * Explain a platform AI capability the paying plan doesn't include,
 * when someone clicks its locked control (voice mic, dictation). The way
 * forward depends on where they are:
 *   - in a workspace document → "ask a workspace admin" (members never
 *     get a purchase prompt);
 *   - billing on → "Upgrade" (pricing page);
 *   - paid plans coming soon → link to the coming-soon page;
 *   - self-hosted → the operator decides; nothing to buy.
 * An own key always unlocks it, so every variant also links Settings → AI.
 */
export function useAiLockedPrompt() {
  const { t } = useI18n()
  const toast = useToast()
  const { billingEnabled, plansComingSoon } = useBillingMode()
  const workspace = useAiWorkspaceContext()
  const marketingPath = useMarketingPath()

  function explainLocked(feature: 'aiVoice' | 'aiImage') {
    const go = (href: string) => () => {
      globalThis.location.href = href
    }
    const actions: Array<{ label: string, color: 'neutral', onClick: () => void }> = []
    let description: string
    if (workspace.value) {
      description = t('ai.locked.askAdmin')
    } else if (billingEnabled.value) {
      description = t('ai.locked.upgrade')
      actions.push({ label: t('ai.upgradeCta'), color: 'neutral', onClick: go(marketingPath('/pricing')) })
    } else if (plansComingSoon.value) {
      description = t('ai.locked.comingSoon')
      actions.push({ label: t('billing.comingSoonCta'), color: 'neutral', onClick: go(marketingPath('/pricing')) })
    } else {
      description = t('ai.locked.operator')
    }
    actions.push({ label: t('ai.locked.ownKey'), color: 'neutral', onClick: go(AI_SETTINGS_ROUTE) })
    toast.add({
      title: t(`ai.locked.${feature}`),
      description,
      icon: 'i-lucide-lock',
      color: 'neutral',
      actions
    })
  }

  return { explainLocked }
}
