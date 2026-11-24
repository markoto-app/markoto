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
  const marketingPath = useMarketingPath()
  const { refresh: refreshBilling } = useBilling()
  const { state: credits, isKnown: creditsKnown, isExhausted: pointsExhausted, isFreeAllowanceExhausted, isWorkspaceShared: creditsAreShared, isTeamBudgetExhausted, canManageWorkspaceBudget, refresh: refreshAiCredits } = useAiCredits(workspaceId)
  const { chatPlatformBilled } = useAiAvailability()
  const { billingEnabled, plansComingSoon, pricingVisible } = useBillingMode()

  // Hosted free tier: the shared monthly pool can run dry before the user's
  // own points do. Only platform-paid chat is affected, an own key keeps working.
  const freePoolExhausted = computed(() => chatPlatformBilled.value && isFreeAllowanceExhausted.value)
  const creditsExhausted = computed(() => freePoolExhausted.value || (chatPlatformBilled.value && pointsExhausted.value))
  // Pro is the top personal plan: the way forward is buying AI Points, not an upgrade.
  const canBuyPersonalPoints = computed(() => billingEnabled.value && !creditsAreShared.value && credits.value?.plan === 'pro')
  // The workspace pool is used up and this user is one of its admins.
  const adminCanRefillWorkspace = computed(() => creditsAreShared.value && isTeamBudgetExhausted.value && canManageWorkspaceBudget.value)

  function goToAiSettings(): void {
    void router.push(AI_SETTINGS_ROUTE)
  }

  function goToBuyPoints(): void {
    void router.push(BUY_AI_POINTS_ROUTE)
  }

  function goToWorkspaceBilling(): void {
    const ws = workspaceId()
    if (ws) void router.push({ path: `/w/${ws}`, query: { tab: 'billing' } })
  }

  // Team / Business workspace: the team pool or the member's own limit is
  // used up. Never "upgrade": admins add seats or buy AI Points for the
  // workspace, members ask an admin.
  function showWorkspaceBudgetToast() {
    if (!isTeamBudgetExhausted.value) {
      toast.add({
        title: t('ai.memberLimitReachedTitle'),
        description: t('ai.memberLimitReachedDescription'),
        icon: 'i-lucide-credit-card',
        color: 'warning'
      })
      return
    }
    const admin = adminCanRefillWorkspace.value
    toast.add({
      title: t('ai.workspaceBudgetExhaustedTitle'),
      description: admin ? t('ai.workspaceBudgetExhaustedAdminDescription') : t('ai.workspaceBudgetExhaustedDescription'),
      icon: 'i-lucide-credit-card',
      color: 'warning',
      actions: admin ? [{ label: t('ai.workspaceBillingCta'), color: 'neutral', onClick: goToWorkspaceBilling }] : undefined
    })
  }

  // Shared free-tier pool used up, never "your points". The ways forward:
  // the user's own key (Settings → AI provider) and, with billing on, Pro,
  // whose budget is outside the free pool.
  function showFreeAllowanceToast() {
    const canUpgrade = billingEnabled.value && !creditsAreShared.value
    const ownKey = { label: t('ai.freeAllowanceCta'), color: 'neutral' as const, onClick: goToAiSettings }
    toast.add({
      title: t('ai.freeAllowanceExhaustedTitle'),
      description: canUpgrade ? t('ai.freeAllowanceExhaustedUpgrade') : t('ai.freeAllowanceExhausted'),
      icon: 'i-lucide-key-round',
      color: 'warning',
      actions: canUpgrade
        ? [{ label: t('ai.upgradeCta'), color: 'primary' as const, onClick: () => { globalThis.location.href = marketingPath('/pricing') } }, ownKey]
        : [ownKey]
    })
  }

  // Personal-pool exhaustion toast. Billing mode picks the copy + CTA:
  // billing on → "Upgrade" (Free) or "Buy AI Points" (Pro, the top personal
  // plan); hosted free-only SaaS → "refills next period, paid plans coming
  // soon" + link to the coming-soon page; self-hosted → "refills next
  // period", nothing to buy. Every variant also offers the user's own key.
  function showPersonalBudgetToast() {
    let description = t('ai.budgetExhaustedDescription')
    let actions: Array<{ label: string, color: 'primary' | 'neutral', onClick: () => void }> | undefined
    const goToPricing = () => {
      globalThis.location.href = marketingPath('/pricing')
    }
    if (canBuyPersonalPoints.value) {
      description = t('ai.budgetExhaustedProDescription')
      actions = [{ label: t('ai.buyPointsCta'), color: 'neutral', onClick: goToBuyPoints }]
    } else if (billingEnabled.value) {
      actions = [{ label: t('ai.upgradeCta'), color: 'primary', onClick: goToPricing }]
    } else if (plansComingSoon.value) {
      description = t('ai.budgetExhaustedComingSoonDescription')
      actions = [{ label: t('billing.comingSoonCta'), color: 'neutral', onClick: goToPricing }]
    } else {
      description = t('ai.budgetExhaustedResetDescription')
    }
    // An own key is never limited by AI Points: always a way forward.
    actions = [...(actions ?? []), { label: t('ai.freeAllowanceCta'), color: 'neutral', onClick: goToAiSettings }]
    toast.add({
      title: t('ai.budgetExhaustedTitle'),
      description,
      icon: 'i-lucide-credit-card',
      color: 'warning',
      actions
    })
  }

  /**
   * At-cap click → the way forward instead of a doomed request (the send
   * button and a click on the greyed-out input): /pricing for Free, buying
   * AI Points for Pro, the workspace's billing for its admins. A member of
   * an exhausted workspace has nothing to buy; the placeholder already says
   * to ask an admin.
   */
  function onCapReached() {
    if (freePoolExhausted.value) {
      showFreeAllowanceToast()
      return
    }
    if (creditsAreShared.value) {
      if (adminCanRefillWorkspace.value) goToWorkspaceBilling()
      return
    }
    if (canBuyPersonalPoints.value) {
      goToBuyPoints()
      return
    }
    if (pricingVisible.value) {
      void router.push(marketingPath('/pricing'))
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
  // credit numbers; this watch reacts to a budget that was known to have
  // points and now has none, and surfaces the toast the user would
  // otherwise miss. Only within one budget: opening a workspace document
  // switches from the user's own budget to the workspace's, and neither the
  // switch nor a budget that was already empty when first read is news.
  let lastReading: { scope: string | null, exhausted: boolean } | null = null
  watch([creditsExhausted, creditsKnown, () => workspaceId() ?? null], ([now, known, scope]) => {
    if (!known) return
    const prev = lastReading
    lastReading = { scope, exhausted: now }
    if (!now || !prev || prev.scope !== scope || prev.exhausted) return
    if (freePoolExhausted.value) {
      showFreeAllowanceToast()
      return
    }
    if (creditsAreShared.value) {
      showWorkspaceBudgetToast()
      return
    }
    showPersonalBudgetToast()
  }, { immediate: true })

  // A failed prompt: the budget notice when a budget ran out, else the generic failure toast.
  watch(() => ai.lastError.value, (err) => {
    if (!err) return
    if (ai.freeAllowanceExhausted?.value) {
      showFreeAllowanceToast()
      void refreshAiCredits()
    } else if (ai.budgetExhausted.value) {
      // Dedicated budget-exhausted toast with the way forward. A generic
      // "AI request failed" toast doesn't tell them what to do.
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

  return { creditsExhausted, freePoolExhausted, creditsAreShared, isTeamBudgetExhausted, adminCanRefillWorkspace, canBuyPersonalPoints, billingEnabled, onCapReached, goToAiSettings }
}
