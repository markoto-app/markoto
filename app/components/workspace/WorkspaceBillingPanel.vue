<script setup lang="ts">
import {
  CURRENCIES,
  defaultCurrencyForLocale,
  type BillingInterval,
  type Currency
} from '~~/shared/config/pricing'
import { useInvalidateAiCredits } from '~/queries/ai'
import { useInvalidatePlan, usePlanPricesQuery } from '~/queries/billing'
import { formatPrice, formatPlanBytes } from '~/utils/billing/pricing'
import { dollarsToPoints } from '~~/shared/billing/aiPoints'
import {
  formatAiPoints,
  minimumSeats,
  type WorkspaceBillingOverview
} from '~/utils/billing/workspaceBilling'

// Workspace billing tab (Team / Business). Admins only;
// the page shows the tab only when billing is on.
//
//   - No subscription yet (or an abandoned checkout): choose Team or
//     Business, monthly or annual, currency and seats → Stripe Checkout.
//   - Subscription: plan, seats in use, renewal date, payment problems,
//     seat changes, plan / billing-period switch, the Stripe portal
//     (invoices, card, cancel), and the pooled AI budget with each
//     member's spend and limit.
// Members never see this tab: they never see a price.

const props = defineProps<{
  workspaceId: string
}>()

const emit = defineEmits<{
  // Seats / plan changed: the page refreshes its copy of the workspace.
  changed: []
}>()

const { t, locale } = useI18n()
const toast = useToast()
const { showError } = useErrorHandler()

const overview = ref<WorkspaceBillingOverview | null>(null)
// Shared with the pricing page and the seat-price prompt; a failed load
// shows no prices.
const pricesQuery = usePlanPricesQuery()
const prices = computed(() => pricesQuery.data.value ?? null)
const loading = ref(true)
const busy = ref<string | null>(null)
// A plan, billing-period or seat change moves what other views cache: the
// workspaces that cover the user and every AI budget (the topbar meter).
const invalidatePlan = useInvalidatePlan()
// A member's limit caps that member's AI points inside this workspace (the
// admin's own, when they set it for themselves): the meter is out of date.
const invalidateWorkspacePoints = useInvalidateAiCredits(() => props.workspaceId)

/** Re-read everything a paid change touched: this tab, the cached snapshots, the page's own copy. */
async function refreshAfterChange() {
  await Promise.all([load(), invalidatePlan()])
  emit('changed')
}

async function load() {
  try {
    const [o] = await Promise.all([
      apiFetch('/api/workspaces/:wsId/billing', { path: { wsId: props.workspaceId } }),
      // The panel shows prices together with the overview, as before.
      pricesQuery.refresh()
    ])
    overview.value = o
    if (o.subscription) {
      currency.value = o.subscription.currency
      interval.value = o.subscription.interval
      plan.value = o.subscription.plan
      seatsDraft.value = o.subscription.seats
    } else {
      seatsDraft.value = minimumSeats(o.minSeats, o.seatsUsed)
    }
  } catch (e) {
    showError('workspace.billing.loadFailed', e)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  currency.value = defaultCurrencyForLocale(globalThis.navigator?.language)
  void load()
})

const sub = computed(() => overview.value?.subscription ?? null)
/** A subscription Stripe still holds (entitled, or in dunning / ending). */
const hasLiveSubscription = computed(() => sub.value !== null && sub.value.status !== 'incomplete' && sub.value.status !== 'incomplete_expired' && sub.value.status !== 'canceled')
const paymentProblem = computed(() => sub.value?.paymentOverdue === true)

const plan = ref<'team' | 'business'>('team')
const interval = ref<BillingInterval>('month')
const currency = ref<Currency>('eur')
const seatsDraft = ref(3)
const minSeats = computed(() => overview.value ? minimumSeats(overview.value.minSeats, overview.value.seatsUsed) : 3)

const planItems = computed(() => [
  { label: 'Team', value: 'team' as const },
  { label: 'Business', value: 'business' as const }
])
const intervalItems = computed(() => [
  { label: t('pricing.interval.month'), value: 'month' as const },
  { label: t('pricing.interval.year'), value: 'year' as const }
])
const currencyItems = CURRENCIES.map(c => ({ label: c.toUpperCase(), value: c }))

function seatPrice(p: 'team' | 'business', i: BillingInterval, c: Currency): number | null {
  return prices.value?.prices[c]?.[p]?.[i] ?? null
}
const perSeat = computed(() => seatPrice(plan.value, interval.value, currency.value))
const totalLabel = computed(() => {
  if (perSeat.value === null) return null
  const total = perSeat.value * seatsDraft.value
  return t(interval.value === 'year' ? 'workspace.billing.totalPerYear' : 'workspace.billing.totalPerMonth', {
    total: formatPrice(total, currency.value.toUpperCase(), locale.value),
    seats: seatsDraft.value,
    price: formatPrice(perSeat.value, currency.value.toUpperCase(), locale.value)
  })
})

// The Paid Plans Terms box: a first purchase and a plan switch
// both need it; seat changes don't (they run under the accepted terms).
const paidTermsAccepted = ref(false)

async function startCheckout() {
  if (!paidTermsAccepted.value) return
  busy.value = 'checkout'
  try {
    const res = await apiFetch('/api/workspaces/:wsId/billing/checkout', {
      method: 'post',
      path: { wsId: props.workspaceId },
      body: { plan: plan.value, interval: interval.value, currency: currency.value, seats: seatsDraft.value, acceptPaidTerms: true }
    })
    // A plan switch of a live subscription answers `{ updated, plan }` instead of a checkout.
    if (!('updated' in res) && res.url) goToExternal(res.url)
  } catch (e) {
    showError('workspace.billing.checkoutFailed', e)
  } finally {
    busy.value = null
  }
}

// Sends only what the button changes (the plan OR the billing period):
// the server keeps the other one as the subscription has it, so a tab
// that shows an older state can't reset it.
async function changePlan(next: { plan: 'team' | 'business' } | { interval: BillingInterval }) {
  if (!sub.value || !paidTermsAccepted.value) return
  busy.value = 'plan'
  try {
    await apiFetch('/api/workspaces/:wsId/billing/checkout', {
      method: 'post',
      path: { wsId: props.workspaceId },
      body: { ...next, acceptPaidTerms: true }
    })
    toast.add({ title: t('workspace.billing.planChanged'), icon: 'i-lucide-check', color: 'neutral' })
    await refreshAfterChange()
  } catch (e) {
    showError('workspace.billing.planChangeFailed', e)
  } finally {
    busy.value = null
  }
}

async function saveSeats() {
  if (!sub.value || seatsDraft.value === sub.value.seats) return
  busy.value = 'seats'
  try {
    await apiFetch('/api/workspaces/:wsId/billing/seats', { method: 'post', path: { wsId: props.workspaceId }, body: { seats: seatsDraft.value } })
    toast.add({ title: t('workspace.billing.seatsChanged', { seats: seatsDraft.value }), icon: 'i-lucide-check', color: 'neutral' })
    await refreshAfterChange()
  } catch (e) {
    showError('workspace.billing.seatsChangeFailed', e)
  } finally {
    busy.value = null
  }
}

async function openPortal() {
  busy.value = 'portal'
  try {
    const res = await apiFetch('/api/workspaces/:wsId/billing/portal', { method: 'post', path: { wsId: props.workspaceId } })
    goToExternal(res.url)
  } catch (e) {
    showError('workspace.billing.portalFailed', e)
  } finally {
    busy.value = null
  }
}

// Member limits are edited in AI Points; the API takes USD (1000 points = $1).
type LimitMode = 'default' | 'custom' | 'none'
const limitDrafts = ref<Record<number, { mode: LimitMode, points: number }>>({})
watch(overview, (o) => {
  const next: Record<number, { mode: LimitMode, points: number }> = {}
  for (const m of o?.members ?? []) {
    next[m.userId] = {
      mode: m.unlimited ? 'none' : m.limitIsDefault ? 'default' : 'custom',
      points: dollarsToPoints(m.limitUsd ?? o?.pool?.defaultMemberLimitUsd ?? 0)
    }
  }
  limitDrafts.value = next
})
const limitModeItems = computed(() => [
  { label: t('workspace.billing.limitDefault'), value: 'default' as const },
  { label: t('workspace.billing.limitCustom'), value: 'custom' as const },
  { label: t('workspace.billing.limitNone'), value: 'none' as const }
])

async function saveLimit(userId: number) {
  const draft = limitDrafts.value[userId]
  if (!draft) return
  busy.value = `limit-${userId}`
  const body = draft.mode === 'default' ? { default: true } : draft.mode === 'none' ? { limitUsd: null } : { limitUsd: draft.points / 1000 }
  try {
    await apiFetch('/api/workspaces/:wsId/billing/members/:userId', { method: 'patch', path: { wsId: props.workspaceId, userId }, body })
    toast.add({ title: t('workspace.billing.limitSaved'), icon: 'i-lucide-check', color: 'neutral' })
    await Promise.all([load(), invalidateWorkspacePoints()])
  } catch (e) {
    showError('workspace.billing.limitSaveFailed', e)
  } finally {
    busy.value = null
  }
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(locale.value, { year: 'numeric', month: 'long', day: 'numeric' })
}
function points(usd: number | null | undefined): string {
  return usd === null || usd === undefined ? '-' : formatAiPoints(usd, locale.value)
}
</script>

<template>
  <section
    class="space-y-6"
    data-testid="workspace-billing-panel"
  >
    <div class="flex items-center gap-2.5">
      <UIcon
        name="i-lucide-credit-card"
        class="text-toned size-5 shrink-0"
      />
      <h2 class="font-serif text-2xl font-normal tracking-tight">
        {{ t('workspace.billing.title') }}
      </h2>
    </div>

    <p
      v-if="loading"
      class="text-sm text-muted"
    >
      {{ t('workspace.billing.loading') }}
    </p>

    <template v-else-if="overview">
      <UAlert
        v-if="paymentProblem"
        color="error"
        variant="subtle"
        icon="i-lucide-alert-triangle"
        :title="t('workspace.billing.paymentProblemTitle')"
        :description="t('workspace.billing.paymentProblemBody')"
        :actions="[{ label: t('workspace.billing.manage'), color: 'neutral', variant: 'outline', onClick: openPortal }]"
        data-testid="workspace-billing-payment-problem"
      />

      <!-- No subscription yet: buy one -->
      <div
        v-if="!hasLiveSubscription"
        class="rounded-lg border border-default bg-default p-5 space-y-5"
        data-testid="workspace-billing-buy"
      >
        <div class="space-y-1">
          <h3 class="font-serif text-lg font-normal tracking-tight">
            {{ t('workspace.billing.buyTitle') }}
          </h3>
          <p class="text-sm text-muted">
            {{ t('workspace.billing.buyBody') }}
          </p>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField :label="t('workspace.billing.planLabel')">
            <UTabs
              v-model="plan"
              :items="planItems"
              :content="false"
              color="neutral"
              size="sm"
              data-testid="workspace-billing-plan"
            />
          </UFormField>
          <UFormField :label="t('pricing.interval.label')">
            <UTabs
              v-model="interval"
              :items="intervalItems"
              :content="false"
              color="neutral"
              size="sm"
              data-testid="workspace-billing-interval"
            />
          </UFormField>
          <UFormField
            :label="t('workspace.billing.seatsLabel')"
            :hint="t('workspace.billing.seatsHint', { min: minSeats })"
          >
            <UInputNumber
              v-model="seatsDraft"
              :min="minSeats"
              :max="1000"
              data-testid="workspace-billing-seats"
            />
          </UFormField>
          <UFormField :label="t('pricing.currencyLabel')">
            <USelect
              v-model="currency"
              :items="currencyItems"
              class="w-28"
              data-testid="workspace-billing-currency"
            />
          </UFormField>
        </div>

        <div class="flex items-center justify-between gap-3 flex-wrap border-t border-default pt-4">
          <p
            class="text-sm"
            data-testid="workspace-billing-total"
          >
            {{ totalLabel ?? '' }}
          </p>
          <PricingPaidTermsConsent
            v-model="paidTermsAccepted"
            kind="plan"
            class="basis-full"
            testid="workspace-billing-checkout-paid-terms"
          />
          <UButton
            color="neutral"
            icon="i-lucide-arrow-right"
            trailing
            :disabled="!paidTermsAccepted"
            :loading="busy === 'checkout'"
            data-testid="workspace-billing-checkout"
            @click="startCheckout"
          >
            {{ t('workspace.billing.continueToPayment') }}
          </UButton>
        </div>
        <p class="text-xs text-muted">
          {{ t('workspace.billing.buyFootnote') }}
        </p>
      </div>

      <!-- Subscription -->
      <template v-else-if="sub">
        <div
          class="rounded-lg border border-default bg-default p-5 space-y-4"
          data-testid="workspace-billing-subscription"
        >
          <div class="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <p class="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
                {{ t('workspace.billing.currentPlan') }}
              </p>
              <p
                class="font-serif text-xl font-normal tracking-tight"
                data-testid="workspace-billing-plan-name"
              >
                {{ sub.plan === 'team' ? 'Team' : 'Business' }} ·
                {{ sub.interval === 'year' ? t('workspace.billing.annual') : t('workspace.billing.monthly') }}
              </p>
              <p
                v-if="sub.cancelAt"
                class="text-xs text-muted mt-1"
                data-testid="workspace-billing-ends"
              >
                {{ t('workspace.billing.ends', { date: fmtDate(sub.cancelAt) }) }}
              </p>
              <!-- No renewal date while a payment is overdue: the notice above says what happens. -->
              <p
                v-else-if="sub.validUntil && !paymentProblem"
                class="text-xs text-muted mt-1"
                data-testid="workspace-billing-renews"
              >
                {{ t('workspace.billing.renews', { date: fmtDate(sub.validUntil) }) }}
              </p>
            </div>
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-external-link"
              :loading="busy === 'portal'"
              data-testid="workspace-billing-portal"
              @click="openPortal"
            >
              {{ t('workspace.billing.manage') }}
            </UButton>
          </div>

          <div class="flex items-end gap-3 flex-wrap border-t border-default pt-4">
            <UFormField
              :label="t('workspace.billing.seatsLabel')"
              :hint="t('workspace.billing.seatCounter', { used: overview.seatsUsed, seats: sub.seats })"
            >
              <UInputNumber
                v-model="seatsDraft"
                :min="minSeats"
                :max="1000"
                data-testid="workspace-billing-seats"
              />
            </UFormField>
            <UButton
              color="neutral"
              :disabled="seatsDraft === sub.seats"
              :loading="busy === 'seats'"
              data-testid="workspace-billing-save-seats"
              @click="saveSeats"
            >
              {{ t('workspace.billing.updateSeats') }}
            </UButton>
          </div>
          <p class="text-xs text-muted">
            {{ t('workspace.billing.seatsFootnote') }}
          </p>

          <div class="flex gap-2 flex-wrap border-t border-default pt-4">
            <PricingPaidTermsConsent
              v-model="paidTermsAccepted"
              kind="plan"
              class="basis-full"
              testid="workspace-billing-switch-paid-terms"
            />
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              :disabled="!paidTermsAccepted"
              :loading="busy === 'plan'"
              data-testid="workspace-billing-switch-plan"
              @click="changePlan({ plan: sub.plan === 'team' ? 'business' : 'team' })"
            >
              {{ sub.plan === 'team' ? t('workspace.billing.switchToBusiness') : t('workspace.billing.switchToTeam') }}
            </UButton>
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              :disabled="!paidTermsAccepted"
              :loading="busy === 'plan'"
              data-testid="workspace-billing-switch-interval"
              @click="changePlan({ interval: sub.interval === 'month' ? 'year' : 'month' })"
            >
              {{ sub.interval === 'month' ? t('workspace.billing.switchToAnnual') : t('workspace.billing.switchToMonthly') }}
            </UButton>
          </div>
        </div>

        <!-- AI credit top-ups -->
        <div
          class="rounded-lg border border-default bg-default p-5 space-y-3"
          data-testid="workspace-billing-credits-card"
        >
          <h3 class="font-serif text-lg font-normal tracking-tight">
            {{ t('credits.title') }}
          </h3>
          <CommonAiCreditsCard
            :credits="overview.credits ?? null"
            :currency="sub.currency"
            :workspace-id="workspaceId"
            :can-buy="sub.entitled"
            testid-prefix="workspace-billing"
          />
        </div>

        <!-- Pooled AI budget + members -->
        <div
          v-if="overview.pool"
          class="rounded-lg border border-default bg-default p-5 space-y-4"
          data-testid="workspace-billing-usage"
        >
          <div class="flex items-center gap-2">
            <CommonSeal :size="9" />
            <h3 class="font-serif text-lg font-normal tracking-tight">
              {{ t('workspace.billing.aiTitle') }}
            </h3>
          </div>
          <p
            class="text-sm"
            data-testid="workspace-billing-team-spend"
          >
            {{ t('workspace.billing.teamSpend', { spent: points(overview.pool.aiSpendUsd), budget: points(overview.pool.aiBudgetUsd) }) }}
            <span
              v-if="overview.pool.resetsAt"
              class="text-muted"
            > · {{ t('workspace.billing.resets', { date: fmtDate(overview.pool.resetsAt) }) }}</span>
          </p>
          <p class="text-xs text-muted">
            {{ t('workspace.billing.storage', { knowledge: formatPlanBytes(overview.pool.knowledgeBytes), images: formatPlanBytes(overview.pool.imageBytes) }) }}
          </p>

          <ul class="divide-y divide-default border-t border-default">
            <li
              v-for="member in overview.members"
              :key="member.userId"
              class="py-3 flex items-center gap-3 flex-wrap"
              :data-testid="`workspace-billing-member-${member.userId}`"
            >
              <CommonUserAvatar
                :seed="`u-${member.userId}`"
                :name="member.name ?? ''"
                :size="28"
              />
              <!-- At least 10rem wide, so on a phone the limit controls wrap below the name. -->
              <div class="min-w-40 flex-1">
                <p class="font-serif text-base font-normal tracking-tight truncate">
                  {{ member.name }}
                </p>
                <p class="font-mono text-[10.5px] tracking-[0.04em] text-muted">
                  {{ t('workspace.billing.memberSpend', { spent: points(member.spendUsd), limit: member.limitUsd === null ? t('workspace.billing.noLimitShort') : points(member.limitUsd) }) }}
                </p>
              </div>
              <div
                v-if="limitDrafts[member.userId]"
                class="flex items-center gap-2"
              >
                <USelect
                  v-model="limitDrafts[member.userId]!.mode"
                  :items="limitModeItems"
                  class="w-36"
                  size="sm"
                  :data-testid="`workspace-billing-limit-mode-${member.userId}`"
                />
                <UInputNumber
                  v-if="limitDrafts[member.userId]!.mode === 'custom'"
                  v-model="limitDrafts[member.userId]!.points"
                  :min="0"
                  :max="10000000"
                  :step="500"
                  size="sm"
                  class="w-32"
                  :aria-label="t('workspace.billing.limitPointsLabel')"
                  :data-testid="`workspace-billing-limit-amount-${member.userId}`"
                />
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :loading="busy === `limit-${member.userId}`"
                  :data-testid="`workspace-billing-limit-save-${member.userId}`"
                  @click="saveLimit(member.userId)"
                >
                  {{ t('common.save') }}
                </UButton>
              </div>
            </li>
          </ul>
          <p class="text-xs text-muted">
            {{ t('workspace.billing.limitFootnote', { points: points(overview.pool.defaultMemberLimitUsd) }) }}
          </p>
        </div>
      </template>
    </template>
  </section>
</template>
