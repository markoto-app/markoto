<script setup lang="ts">
import { defaultCurrencyForLocale } from '~~/shared/config/pricing'
import { formatBytes, usageFill } from '~/utils/billing/usageMeter'
import { formatPrice } from '~/utils/billing/pricing'
import { usePlanPricesQuery } from '~/queries/billing'
import { accountLanguageName } from '~/utils/platform/localeName'
// User profile page. The single canonical surface for account-level
// management: who you are, the data we hold about you, and the
// controls (export + delete) for managing it.
//
// Modal-style page with a close button that returns the user to
// their previous route (mirrors /pricing's UX). Auth-gated client-
// side via redirect; the data-fetching endpoints are session-required
// so deep-linking without a session lands in the 401-toast surface.

const router = useRouter()
const { t, locale, locales } = useI18n()
// The spending section is a billing surface, hidden entirely when
// billing is off (self-hosted / free-only SaaS).
const { billingEnabled } = useBillingMode()
const toast = useToast()
const { showError, extractError } = useErrorHandler()
const { loggedIn, user } = useUserSession()
const { status, pending: statusPending, refresh: refreshAccountStatus } = useAccountStatus()
// An account that never stored a language shows the one the UI is in.
const languageName = computed(() => accountLanguageName(status.value?.locale, locale.value, locales.value))
// Legal acceptance section only where the legal surfaces
// exist (hosted SaaS); see shared/config/instance.ts.
const { legalSurfaces, primaryLoginPath } = useInstanceConfig()

useHead({ title: () => t('settings.profile.title') })

if (import.meta.client && !loggedIn.value) {
  globalThis.location.href = primaryLoginPath.value ?? '/'
}

function onClose(): void {
  if (globalThis.history.length > 1 && document.referrer) {
    router.back()
  } else {
    void router.push('/')
  }
}

// "Log out everywhere" bumps the server-side session epoch, which
// invalidates every session cookie (other browsers, devices, and this
// one), then runs the normal logout clean-up + hard reload.
const { logout } = useLogout()
const revokingSessions = ref(false)
async function onLogoutEverywhere(): Promise<void> {
  if (revokingSessions.value) return
  revokingSessions.value = true
  try {
    await apiFetch('/api/user/sessions/revoke', { method: 'post' })
    await logout()
  } catch (e) {
    showError('settings.profile.sessions.failed', e)
    revokingSessions.value = false
  }
}

onMounted(() => {
  void refreshAccountStatus()
})

const { billing, pending: billingPending, refresh: refreshBilling } = useBilling()

// Pro: manage the subscription in the Stripe portal and buy AI credits.
const creditCurrency = ref<'eur' | 'chf'>('eur')
const openingPortal = ref(false)
async function openPortal(): Promise<void> {
  openingPortal.value = true
  try {
    const res = await apiFetch('/api/billing/portal', { method: 'post' })
    goToExternal(res.url)
  } catch (e) {
    showError('settings.profile.spending.portalFailed', e)
  } finally {
    openingPortal.value = false
  }
}

// Pro: billing-period switch, or "Resume plan" once cancelled
// (SettingsProPlanChanges).
const isPro = computed(() => billing.value?.plan === 'pro')
const planLabel = computed(() => {
  if (!isPro.value) return t('pricing.price.free')
  const interval = billing.value?.interval
  return interval ? `Pro · ${interval === 'year' ? t('workspace.billing.annual') : t('workspace.billing.monthly')}` : 'Pro'
})
// What the plan costs, in the subscription's own currency and period.
const pricesQuery = usePlanPricesQuery()
const planPrice = computed(() => {
  const b = billing.value
  const table = pricesQuery.data.value?.prices
  if (!isPro.value || !b?.interval || !b.currency || !table) return null
  const price = formatPrice(table[b.currency].pro[b.interval], b.currency.toUpperCase(), locale.value)
  return t(b.interval === 'year' ? 'settings.profile.spending.pricePerYear' : 'settings.profile.spending.pricePerMonth', { price })
})
// The line under the plan: when a cancelled plan ends, else when it renews.
// No renewal date while a payment is overdue: the notice below says what
// happens instead.
const planDateLine = computed(() => {
  const b = billing.value
  if (!isPro.value || !b) return null
  if (b.cancelAt) return { testid: 'profile-plan-ends', text: t('workspace.billing.ends', { date: fmtDateOnly(b.cancelAt) }) }
  if (b.paymentOverdue || !b.periodEnd) return null
  return { testid: 'profile-plan-renews', text: t('workspace.billing.renews', { date: fmtDateOnly(b.periodEnd) }) }
})
const route = useRoute()
onMounted(() => {
  creditCurrency.value = defaultCurrencyForLocale(globalThis.navigator?.language)
  if (route.query.credits === 'success') {
    toast.add({ title: t('credits.purchased'), description: t('credits.purchasedBody'), icon: 'i-lucide-check', color: 'neutral' })
    void refreshBilling()
  }
  if (route.query.credits) void router.replace({ query: {} })
})
const imageStoragePercent = computed(() => {
  const b = billing.value
  if (!b) return 0
  return usageFill(b.imageBytesUsed, b.imageBytesPerUserLimit).pct
})

const fmtBytes = formatBytes

function fmtDate(iso: string | null): string {
  return formatDateTime(iso, locale.value)
}

function fmtDateOnly(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(locale.value, {
      year: 'numeric', month: 'long', day: 'numeric'
    })
  } catch {
    return iso
  }
}

const deletionModalOpen = ref(false)
function openDeletionModal(): void {
  deletionModalOpen.value = true
}
async function onDeletionScheduled(): Promise<void> {
  await refreshAccountStatus()
}

const cancellingDeletion = ref(false)
async function onCancelDeletion(): Promise<void> {
  if (cancellingDeletion.value) return
  cancellingDeletion.value = true
  try {
    await apiFetch('/api/user/delete-cancel', { method: 'post' })
    await refreshAccountStatus()
    toast.add({
      title: t('legal.delete.cancelledToast'),
      description: '',
      icon: 'i-lucide-check',
      color: 'neutral'
    })
  } catch (e) {
    toast.add({
      title: t('settings.profile.delete.cancelFailed'),
      description: extractError(e).message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    cancellingDeletion.value = false
  }
}

const deletionPending = computed(() => status.value?.deletion?.pending === true)
const deletionGraceFormatted = computed(() => fmtDate(status.value?.deletion?.graceUntil ?? null))

const policies = computed(() => {
  const p = status.value?.policy
  if (!p) return []
  return [
    { key: 'privacy', label: t('legal.policyAcceptance.documentNames.privacy'), state: p.privacy, contextual: false },
    { key: 'tos', label: t('legal.policyAcceptance.documentNames.tos'), state: p.tos, contextual: false },
    // DPA is workspace-owner only (B2B). When the user hasn't
    // accepted, surface that as "Required when you create a
    // workspace" rather than the rose "needs re-acceptance"
    // warning: DPA acceptance is contextual, not overdue.
    { key: 'dpa', label: t('legal.policyAcceptance.documentNames.dpa'), state: p.dpa, contextual: true }
  ]
})
</script>

<template>
  <div class="min-h-[100dvh] bg-default text-default relative">
    <CommonHomeLink />
    <UButton
      icon="i-lucide-x"
      color="neutral"
      variant="ghost"
      size="md"
      class="absolute top-4 right-4 z-10"
      :aria-label="t('pricing.close')"
      @click="onClose"
    />

    <main class="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <!-- Header: identity at the top, mirroring how a real profile page reads. -->
      <header class="mb-10">
        <p class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
          /settings
        </p>
        <!-- Avatar steps down a size on mobile (xl → lg) so the
             header doesn't dominate the 667-tall mobile viewport,
             and the email truncates with `min-w-0` + `truncate`
             so a long address can't push the close button off-screen. -->
        <div class="flex items-center gap-3 sm:gap-4 mb-4">
          <CommonUserAvatar
            v-if="user"
            :seed="avatarSeedFor({ id: user.id })"
            :name="user.name"
            :size="40"
            class="sm:!size-16"
          />
          <div class="min-w-0 flex-1">
            <h1 class="font-serif text-2xl sm:text-4xl font-normal tracking-tight truncate">
              {{ user?.name ?? t('settings.profile.title') }}
            </h1>
            <p
              v-if="status?.email"
              class="text-xs sm:text-sm text-muted font-mono truncate"
            >
              {{ status.email }}
            </p>
          </div>
        </div>
        <p class="text-sm text-muted">
          {{ t('settings.profile.intro') }}
        </p>
      </header>

      <!-- Account meta: read-only for now (locale + age confirmation are
           managed elsewhere; surfaced here for transparency). -->
      <section
        class="mb-10"
        data-testid="profile-account-section"
      >
        <h2 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-3">
          {{ t('settings.profile.account.heading') }}
        </h2>
        <!-- Stack rows vertically on mobile (label above value) so a
             long email or non-Latin locale name doesn't squeeze
             against the right edge. `sm:flex-row sm:justify-between`
             restores the desktop "label · value" layout. -->
        <dl class="border border-default rounded-lg divide-y divide-default">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 px-4 py-3">
            <dt class="text-sm text-muted shrink-0">
              {{ t('settings.profile.account.email') }}
            </dt>
            <dd class="text-sm font-mono break-all sm:break-normal sm:text-right">
              <USkeleton
                v-if="statusPending"
                class="h-4 w-48"
                data-testid="profile-account-skeleton"
              />
              <template v-else>
                {{ status?.email ?? '-' }}
              </template>
            </dd>
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 px-4 py-3">
            <dt class="text-sm text-muted shrink-0">
              {{ t('settings.profile.account.locale') }}
            </dt>
            <dd
              class="text-sm font-mono sm:text-right"
              data-testid="profile-language"
            >
              <USkeleton
                v-if="statusPending"
                class="h-4 w-24"
              />
              <template v-else>
                {{ languageName }}
              </template>
            </dd>
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 px-4 py-3">
            <dt class="text-sm text-muted shrink-0">
              {{ t('settings.profile.account.ageConfirmed') }}
            </dt>
            <dd class="text-sm font-mono sm:text-right">
              <USkeleton
                v-if="statusPending"
                class="h-4 w-32"
              />
              <template v-else>
                {{ status?.age?.confirmedAt
                  ? fmtDateOnly(status.age.confirmedAt)
                  : t('settings.profile.account.ageNotConfirmed') }}
              </template>
            </dd>
          </div>
        </dl>
      </section>

      <!-- Sessions: sign out of every browser and device. -->
      <section
        class="mb-10"
        data-testid="profile-sessions-section"
      >
        <h2 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-3">
          {{ t('settings.profile.sessions.heading') }}
        </h2>
        <div class="border border-default rounded-lg px-4 py-4">
          <p class="text-sm text-muted mb-4">
            {{ t('settings.profile.sessions.description') }}
          </p>
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-log-out"
            :loading="revokingSessions"
            data-testid="logout-everywhere-button"
            @click="onLogoutEverywhere"
          >
            {{ t('settings.profile.sessions.button') }}
          </UButton>
        </div>
      </section>

      <!-- Storage: document images vs. the per-user quota (shown in
           every billing mode: the limit is real either way). -->
      <section
        v-if="billing || billingPending"
        class="mb-10"
        data-testid="profile-storage-section"
      >
        <h2 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-3">
          {{ t('settings.profile.storage.heading') }}
        </h2>
        <div class="border border-default rounded-lg px-4 py-4">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 mb-2">
            <span class="text-sm text-muted">{{ t('settings.profile.storage.images') }}</span>
            <span
              v-if="billing"
              class="text-sm font-mono sm:text-right"
              data-testid="profile-image-storage"
            >
              {{ fmtBytes(billing.imageBytesUsed) }} / {{ fmtBytes(billing.imageBytesPerUserLimit) }}
            </span>
            <USkeleton
              v-else
              class="h-4 w-32"
            />
          </div>
          <UProgress
            :model-value="imageStoragePercent"
            size="xs"
            color="neutral"
            class="mb-3"
          />
          <p class="text-sm text-muted">
            {{ t('settings.profile.storage.description') }}
          </p>
        </div>
      </section>

      <!-- Spending: the plan with its price and dates, the workspaces that
           cover the user, and extra AI Points. -->
      <section
        v-if="billingEnabled"
        class="mb-10"
        data-testid="profile-spending-section"
      >
        <h2 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-3">
          {{ t('settings.profile.spending.heading') }}
        </h2>
        <div
          v-if="!billing && billingPending"
          class="border border-default rounded-lg px-4 py-4 space-y-3"
          data-testid="profile-spending-skeleton"
        >
          <USkeleton class="h-4 w-40" />
          <USkeleton class="h-4 w-56" />
          <USkeleton class="h-8 w-full" />
        </div>
        <div
          v-else-if="billing"
          class="border border-default rounded-lg px-4 py-4 space-y-4"
        >
          <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div class="space-y-1 min-w-0">
              <p
                class="text-sm"
                data-testid="profile-plan"
              >
                {{ t('settings.profile.spending.plan', { plan: planLabel }) }}
              </p>
              <p
                v-if="planPrice"
                class="text-sm text-muted"
                data-testid="profile-plan-price"
              >
                {{ planPrice }}
              </p>
              <p
                v-if="planDateLine"
                class="text-sm text-muted"
                :data-testid="planDateLine.testid"
              >
                {{ planDateLine.text }}
              </p>
            </div>
            <div class="flex gap-2 flex-wrap shrink-0">
              <UButton
                v-if="isPro"
                color="neutral"
                variant="outline"
                icon="i-lucide-external-link"
                :loading="openingPortal"
                data-testid="profile-billing-portal"
                @click="openPortal"
              >
                {{ t('settings.profile.spending.manage') }}
              </UButton>
              <UButton
                color="neutral"
                variant="ghost"
                icon="i-lucide-credit-card"
                to="/pricing"
              >
                {{ t('settings.profile.spending.viewPricing') }}
              </UButton>
            </div>
          </div>
          <!-- The last renewal was not paid; Stripe retries, the plan still runs. -->
          <UAlert
            v-if="isPro && billing?.paymentOverdue"
            color="error"
            variant="subtle"
            icon="i-lucide-alert-triangle"
            :title="t('settings.profile.spending.paymentOverdueTitle')"
            :description="t('settings.profile.spending.paymentOverdueBody')"
            :actions="[{ label: t('settings.profile.spending.manage'), color: 'neutral', variant: 'outline', onClick: openPortal }]"
            data-testid="profile-payment-overdue"
          />
          <SettingsProPlanChanges
            v-if="isPro && billing?.interval"
            :interval="billing.interval"
            :cancel-at="billing.cancelAt"
          />
          <div
            v-if="billing?.coveringWorkspaces?.length"
            class="border-t border-default pt-4"
            data-testid="profile-covering-workspaces"
          >
            <p class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
              {{ t('settings.profile.spending.coveringTitle') }}
            </p>
            <ul class="text-sm space-y-1">
              <li
                v-for="ws in billing.coveringWorkspaces"
                :key="ws.workspaceId"
              >
                <NuxtLink
                  :to="`/w/${ws.workspaceId}`"
                  class="underline"
                >{{ ws.name }}</NuxtLink>
                <span class="text-muted"> · {{ ws.plan === 'team' ? 'Team' : 'Business' }}</span>
              </li>
            </ul>
            <p class="text-sm text-muted mt-2">
              {{ t('settings.profile.spending.coveringHint') }}
            </p>
          </div>
          <div
            id="ai-points"
            class="border-t border-default pt-4 scroll-mt-20"
          >
            <p class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
              {{ t('credits.title') }}
            </p>
            <CommonAiCreditsCard
              :credits="billing.credits ?? null"
              :currency="billing.currency ?? creditCurrency"
              :can-buy="isPro"
              :blocked-reason="t('credits.needsPlan')"
              testid-prefix="profile"
            />
          </div>
        </div>
      </section>

      <!-- Your data: export. -->
      <SettingsDataExportSection :deletion-pending="deletionPending" />

      <!-- Delete account: last because it's the most destructive. -->
      <section
        class="mb-10"
        data-testid="profile-delete-section"
      >
        <h2 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-3">
          {{ t('settings.profile.delete.heading') }}
        </h2>

        <div
          v-if="deletionPending"
          class="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4"
          data-testid="deletion-pending-card"
        >
          <p class="text-sm font-medium mb-1">
            {{ t('legal.delete.graceBannerTitle') }}
          </p>
          <p class="text-xs text-muted font-mono mb-3">
            {{ t('settings.profile.delete.scheduled', { date: deletionGraceFormatted }) }}
          </p>
          <UButton
            color="neutral"
            variant="outline"
            :loading="cancellingDeletion"
            @click="onCancelDeletion"
          >
            {{ t('settings.profile.delete.cancel') }}
          </UButton>
        </div>

        <div
          v-else
          class="border border-default rounded-lg px-4 py-4"
        >
          <p class="text-sm text-muted mb-4">
            {{ t('settings.profile.delete.description') }}
          </p>
          <UButton
            color="error"
            variant="soft"
            icon="i-lucide-trash-2"
            data-testid="delete-account-button"
            @click="openDeletionModal"
          >
            {{ t('settings.profile.delete.button') }}
          </UButton>
        </div>
      </section>

      <!-- Legal: secondary content; lists accepted document versions
           with the cookie note. Surfaced for transparency
           but visually de-emphasised: it's a reference card, not a
           call-to-action. -->
      <section
        v-if="legalSurfaces"
        class="mb-10"
        data-testid="profile-legal-section"
      >
        <h2 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-3">
          {{ t('settings.profile.legal.heading') }}
        </h2>
        <p class="text-sm text-muted mb-3">
          {{ t('settings.profile.legal.subheading') }}
        </p>
        <dl class="border border-default rounded-lg divide-y divide-default">
          <div
            v-for="row in policies"
            :key="row.key"
            class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 px-4 py-3"
          >
            <dt class="text-sm shrink-0">
              <NuxtLink
                :to="`/legal/${row.key === 'tos' ? 'terms' : row.key}`"
                class="hover:underline"
              >
                {{ row.label }}
              </NuxtLink>
            </dt>
            <dd class="text-xs font-mono text-muted sm:text-right">
              <!-- Three branches:
                   1. Document accepted → "Version 13, accepted on <date>" (no date once the audit row aged out).
                   2. DPA not yet relevant (workspace-owner only) → show contextual hint, no rose warning.
                   3. Document needs acceptance → "Not accepted" + rose re-acceptance flag. -->
              <span
                v-if="row.state.acceptedVersion !== null"
                :data-testid="`profile-legal-accepted-${row.key}`"
              >
                {{ row.state.acceptedAt
                  ? t('settings.profile.legal.accepted', { version: row.state.acceptedVersion, date: fmtDateOnly(row.state.acceptedAt) })
                  : t('settings.profile.legal.acceptedVersion', { version: row.state.acceptedVersion }) }}
                <span
                  v-if="row.state.acceptanceRequired"
                  class="block sm:inline sm:ml-2 text-rose-700 dark:text-rose-300"
                >
                  {{ t('settings.profile.legal.needsReacceptance', { version: row.state.currentVersion }) }}
                </span>
              </span>
              <span v-else-if="row.contextual">
                {{ t('settings.profile.legal.dpaNotApplicable') }}
              </span>
              <span v-else>
                {{ t('settings.profile.legal.notAccepted') }}
              </span>
            </dd>
          </div>
        </dl>
        <p
          class="text-sm text-muted mt-3"
          data-testid="profile-cookie-note"
        >
          {{ t('settings.profile.legal.cookieNote') }}
        </p>
      </section>
    </main>
    <!-- No site footer: the settings pages open like an overlay (close
         button top right). The legal documents are linked in the section
         above. -->

    <LegalAccountDeletionConsequencesModal
      v-model:open="deletionModalOpen"
      @scheduled="onDeletionScheduled"
    />
  </div>
</template>
