import { apiErrorMessageKey } from '~~/shared/api/errors'
import { IMAGE_PROVIDER_UNAVAILABLE_MESSAGE } from '~~/shared/utils/aiProviderOutage'

/** The slice of `useAI` the budget notices read. */
interface AiSessionErrors {
  mySessionId: Readonly<Ref<string | null>>
  lastError: Readonly<Ref<string | null>>
  budgetExhausted: Readonly<Ref<boolean>>
  freeAllowanceExhausted?: Readonly<Ref<boolean>>
  clearLastError: () => void
}

/**
 * The AI prompt bar's budget state and the notices it shows. Exhaustion comes
 * from /api/ai/credits (LiteLLM /key/info); the credits refresh after a
 * session ends so the AI Points badge ticks down live. AI Points only gate
 * the bar when chat actually spends them: a user on their own key is never
 * blocked by an empty platform budget. Which notice and which way forward
 * depend on whose budget ran dry (the shared free-tier pool, a Team /
 * Business workspace's pool or member limit, the user's own points) and on
 * the billing mode.
 */
export function useAiBudgetNotices(ai: AiSessionErrors, workspaceId: () => string | null | undefined) {
  const { t } = useI18n()
  const toast = useToast()
  const router = useRouter()
  const { refresh: refreshBilling } = useBilling()
  const { isExhausted: pointsExhausted, isFreeAllowanceExhausted, isWorkspaceShared: creditsAreShared, isTeamBudgetExhausted, refresh: refreshAiCredits } = useAiCredits(workspaceId)
  const { chatPlatformBilled } = useAiAvailability()
  const { billingEnabled, plansComingSoon, pricingVisible } = useBillingMode()

  // Hosted free tier: the shared monthly pool can run dry before the user's
  // own points do. Only platform-paid chat is affected, an own key keeps working.
  const freePoolExhausted = computed(() => chatPlatformBilled.value && isFreeAllowanceExhausted.value)
  const creditsExhausted = computed(() => freePoolExhausted.value || (chatPlatformBilled.value && pointsExhausted.value))

  function goToAiSettings(): void {
    void router.push(AI_SETTINGS_ROUTE)
  }

  // Team / Business workspace: the team pool or the member's own limit is
  // used up. Only an admin can change either, so never "upgrade".
  function showWorkspaceBudgetToast() {
    const team = isTeamBudgetExhausted.value
    toast.add({
      title: team ? t('ai.workspaceBudgetExhaustedTitle') : t('ai.memberLimitReachedTitle'),
      description: team ? t('ai.workspaceBudgetExhaustedDescription') : t('ai.memberLimitReachedDescription'),
      icon: 'i-lucide-credit-card',
      color: 'warning'
    })
  }

  // Shared free-tier pool used up: the way forward is the user's own key
  // (Settings → AI provider), never an upgrade, and not "your points".
  function showFreeAllowanceToast() {
    toast.add({
      title: t('ai.freeAllowanceExhaustedTitle'),
      description: t('ai.freeAllowanceExhausted'),
      icon: 'i-lucide-key-round',
      color: 'warning',
      actions: [{ label: t('ai.freeAllowanceCta'), color: 'neutral', onClick: goToAiSettings }]
    })
  }

  // Personal-pool exhaustion toast. Billing mode picks the copy + CTA:
  // billing on → "Upgrade"; hosted free-only SaaS → "refills next period,
  // paid plans coming soon" + link to the coming-soon page; self-hosted →
  // "refills next period", no action (there is nothing to buy).
  function showPersonalBudgetToast() {
    let description = t('ai.budgetExhaustedDescription')
    if (!billingEnabled.value) {
      description = plansComingSoon.value
        ? t('ai.budgetExhaustedComingSoonDescription')
        : t('ai.budgetExhaustedResetDescription')
    }
    let actions: Array<{ label: string, color: 'primary' | 'neutral', onClick: () => void }> | undefined
    const goToPricing = () => {
      globalThis.location.href = '/pricing'
    }
    if (billingEnabled.value) {
      actions = [{ label: t('ai.upgradeCta'), color: 'primary', onClick: goToPricing }]
    } else if (plansComingSoon.value) {
      actions = [{ label: t('billing.comingSoonCta'), color: 'neutral', onClick: goToPricing }]
    }
    toast.add({
      title: t('ai.budgetExhaustedTitle'),
      description,
      icon: 'i-lucide-credit-card',
      color: 'warning',
      actions
    })
  }

  /**
   * At-cap click → /pricing instead of a doomed request (the send button and
   * a click on the greyed-out input). No redirect when the exhausted pool is
   * workspace-shared: the member has nothing to upgrade; the toast already
   * told them to contact the owner.
   */
  function onCapReached() {
    if (freePoolExhausted.value) {
      showFreeAllowanceToast()
      return
    }
    if (creditsAreShared.value) return
    if (pricingVisible.value) {
      void router.push('/pricing')
      return
    }
    // Self-hosted: nothing to buy, re-explain instead of a dead link.
    showPersonalBudgetToast()
  }

  watch(() => ai.mySessionId.value, (now, prev) => {
    if (prev && !now) {
      void refreshBilling()
      void refreshAiCredits()
    }
  })

  // When the run loop's mid-loop catch fires (LitellmBudgetExhausted from
  // the proxy), the prompt request itself returned 200, so `useAI` has no
  // `budgetExhausted` flip. The session-end refresh above pulls the new
  // credit numbers; this watch reacts to the false→true transition and
  // surfaces the toast the user would otherwise miss.
  watch(creditsExhausted, (now, prev) => {
    if (now && !prev) {
      if (freePoolExhausted.value) {
        showFreeAllowanceToast()
        return
      }
      // Workspace-shared pool exhausted: the member can't fix this by
      // upgrading; only the workspace admin's plan / spend matters. Use
      // the workspace copy and drop the upgrade CTA.
      if (creditsAreShared.value) {
        showWorkspaceBudgetToast()
        return
      }
      showPersonalBudgetToast()
    }
  })

  // A failed prompt: the budget notice when a budget ran out, else the generic failure toast.
  watch(() => ai.lastError.value, (err) => {
    if (!err) return
    if (ai.freeAllowanceExhausted?.value) {
      showFreeAllowanceToast()
      void refreshAiCredits()
    } else if (ai.budgetExhausted.value) {
      // Dedicated budget-exhausted toast with an Upgrade action. Users
      // need an obvious path forward, a generic "AI request failed"
      // toast doesn't tell them what to do.
      if (creditsAreShared.value) {
        showWorkspaceBudgetToast()
        return
      }
      showPersonalBudgetToast()
    } else {
      toast.add({
        title: t('ai.failed'),
        description: err === IMAGE_PROVIDER_UNAVAILABLE_MESSAGE ? t(apiErrorMessageKey('ai/image-provider-unavailable')) : err,
        icon: 'i-lucide-alert-circle',
        color: 'error'
      })
    }
    ai.clearLastError()
  })

  return { creditsExhausted, freePoolExhausted, creditsAreShared, isTeamBudgetExhausted, billingEnabled, onCapReached, goToAiSettings }
}
