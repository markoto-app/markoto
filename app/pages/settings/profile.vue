<script setup lang="ts">
// User profile page. The single canonical surface for account-level
// management: who you are, the data we hold about you, and the
// controls (export + delete) for managing it. Spending and usage
// will land here as those features ship — see the dedicated section
// below.
//
// Modal-style page with a close button that returns the user to
// their previous route (mirrors /pricing's UX). Auth-gated client-
// side via redirect; the data-fetching endpoints are session-required
// so deep-linking without a session lands in the 401-toast surface.

interface ExportJob {
  jobId: string
  status: 'queued' | 'running' | 'ready' | 'expired' | 'failed'
  sizeBytes: number | null
  errorMessage: string | null
  expiresAt: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  downloadable: boolean
}

const router = useRouter()
const { t } = useI18n()
// The spending section is a billing surface — hidden entirely when
// billing is off (self-hosted / free-only SaaS).
const { billingEnabled } = useBillingMode()
const toast = useToast()
const { handleReauthRequired, showError } = useErrorHandler()
const { loggedIn, user } = useUserSession()
const { status, refresh: refreshAccountStatus } = useAccountStatus()
// Legal acceptance section only where the legal surfaces
// exist (hosted SaaS); see shared/config/instance.ts.
const { legalSurfaces, primaryLoginPath } = useInstanceConfig()

useHead({ title: `${t('settings.profile.title')} · markoto` })

if (import.meta.client && !loggedIn.value) {
  globalThis.location.href = primaryLoginPath.value ?? '/'
}

function onClose(): void {
  if (globalThis.history.length > 1 && document.referrer) {
    router.back()
  } else {
    router.push('/')
  }
}

// ─────────── Sessions ───────────
// "Log out everywhere" bumps the server-side session epoch, which
// invalidates every session cookie (other browsers, devices, and this
// one), then runs the normal logout clean-up + hard reload.
const { logout } = useLogout()
const revokingSessions = ref(false)
async function onLogoutEverywhere(): Promise<void> {
  if (revokingSessions.value) return
  revokingSessions.value = true
  try {
    await $fetch('/api/user/sessions/revoke', { method: 'POST' })
    await logout()
  } catch (e) {
    showError('settings.profile.sessions.failed', e)
    revokingSessions.value = false
  }
}

// ─────────── Export jobs ───────────
const exports = ref<ExportJob[]>([])
const exportsLoading = ref(false)
const requestingExport = ref(false)

async function refreshExports(): Promise<void> {
  if (!loggedIn.value) return
  exportsLoading.value = true
  try {
    exports.value = await $fetch<ExportJob[]>('/api/user/exports')
  } catch (e) {
    const err = e as { message?: string, data?: { message?: string } }
    toast.add({
      title: 'Could not load exports',
      description: err.data?.message ?? err.message ?? 'Unknown error',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    exportsLoading.value = false
  }
}

onMounted(() => {
  void refreshAccountStatus()
  void refreshExports()
})

const hasActiveExport = computed(() =>
  exports.value.some(j => j.status === 'queued' || j.status === 'running')
)

// Auto-poll while a job is in flight. Worker tick is 60s in prod;
// 5s polling means the user sees the row flip to ready within
// seconds of the worker completing. Email is the out-of-band channel
// for users who closed the tab; this covers everyone else. Interval
// is set on first transition into "active" and cleared the moment
// `hasActiveExport` flips back to false (or component unmounts).
let pollHandle: ReturnType<typeof setInterval> | null = null
function startPolling(): void {
  if (pollHandle !== null) return
  pollHandle = setInterval(() => {
    void refreshExports()
  }, 5000)
}
function stopPolling(): void {
  if (pollHandle === null) return
  clearInterval(pollHandle)
  pollHandle = null
}
watch(hasActiveExport, (active) => {
  if (active) startPolling()
  else stopPolling()
})
onBeforeUnmount(() => stopPolling())

async function onRequestExport(): Promise<void> {
  if (requestingExport.value) return
  requestingExport.value = true
  try {
    await $fetch('/api/user/export', { method: 'POST' })
    toast.add({
      title: t('settings.profile.data.exportInProgress'),
      description: '',
      icon: 'i-lucide-package',
      color: 'neutral'
    })
    await refreshExports()
  } catch (e) {
    if (handleReauthRequired(e)) return
    const err = e as { message?: string, data?: { message?: string } }
    toast.add({
      title: 'Could not request export',
      description: err.data?.message ?? err.message ?? 'Unknown error',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    requestingExport.value = false
  }
}

// ─────────── Storage ───────────
const { billing } = useBilling()
const imageStoragePercent = computed(() => {
  const b = billing.value
  if (!b || b.imageBytesPerUserLimit <= 0) return 0
  return Math.min(100, Math.round((b.imageBytesUsed / b.imageBytesPerUserLimit) * 100))
})

function fmtBytes(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  } catch {
    return iso
  }
}

function fmtDateOnly(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric'
    })
  } catch {
    return iso
  }
}

// ─────────── Delete confirmation modal ───────────
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
    await $fetch('/api/user/delete-cancel', { method: 'POST' })
    await refreshAccountStatus()
    toast.add({
      title: t('legal.delete.cancelledToast'),
      description: '',
      icon: 'i-lucide-check',
      color: 'neutral'
    })
  } catch (e) {
    const err = e as { message?: string, data?: { message?: string } }
    toast.add({
      title: 'Could not cancel deletion',
      description: err.data?.message ?? err.message ?? 'Unknown error',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    cancellingDeletion.value = false
  }
}

const deletionPending = computed(() => status.value?.deletion?.pending === true)
const deletionGraceFormatted = computed(() => fmtDate(status.value?.deletion?.graceUntil ?? null))

// ─────────── Legal acceptance ───────────
const policies = computed(() => {
  const p = status.value?.policy
  if (!p) return []
  return [
    { key: 'privacy', label: t('legal.policyAcceptance.documentNames.privacy'), state: p.privacy, contextual: false },
    { key: 'tos', label: t('legal.policyAcceptance.documentNames.tos'), state: p.tos, contextual: false },
    // DPA is workspace-owner only (B2B). When the user hasn't
    // accepted, surface that as "Required when you create a
    // workspace" rather than the rose "needs re-acceptance"
    // warning — DPA acceptance is contextual, not overdue.
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

      <!-- Account meta — read-only for now (locale + age confirmation are
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
              {{ status?.email ?? '—' }}
            </dd>
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 px-4 py-3">
            <dt class="text-sm text-muted shrink-0">
              {{ t('settings.profile.account.locale') }}
            </dt>
            <dd class="text-sm font-mono sm:text-right">
              {{ status?.locale ?? '—' }}
            </dd>
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 px-4 py-3">
            <dt class="text-sm text-muted shrink-0">
              {{ t('settings.profile.account.ageConfirmed') }}
            </dt>
            <dd class="text-sm font-mono sm:text-right">
              {{ status?.age?.confirmedAt
                ? fmtDateOnly(status.age.confirmedAt)
                : t('settings.profile.account.ageNotConfirmed') }}
            </dd>
          </div>
        </dl>
      </section>

      <!-- Sessions — sign out of every browser and device. -->
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

      <!-- Storage — document images vs. the per-user quota (shown in
           every billing mode: the limit is real either way). -->
      <section
        v-if="billing"
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
              class="text-sm font-mono sm:text-right"
              data-testid="profile-image-storage"
            >
              {{ fmtBytes(billing.imageBytesUsed) }} / {{ fmtBytes(billing.imageBytesPerUserLimit) }}
            </span>
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

      <!-- ─────────────────────────────────────────────────────────────
           Spending & usage placeholder. When the spending feature
           ships (per-period AI credit usage, plan history table,
           invoice list, downloadable receipts), it lands HERE — same
           card shape as the other sections, between Account and
           Your data. The structural slot is reserved on purpose so a
           future implementer doesn't have to rearrange the page.
           ───────────────────────────────────────────────────────── -->
      <section
        v-if="billingEnabled"
        class="mb-10"
        data-testid="profile-spending-section"
      >
        <h2 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-3">
          {{ t('settings.profile.spending.heading') }}
        </h2>
        <div class="border border-default rounded-lg px-4 py-4">
          <p class="text-sm text-muted mb-3">
            {{ t('settings.profile.spending.comingSoon') }}
          </p>
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-credit-card"
            to="/pricing"
          >
            {{ t('settings.profile.spending.viewPricing') }}
          </UButton>
        </div>
      </section>

      <!-- Your data — export. -->
      <section
        class="mb-10"
        data-testid="profile-data-section"
      >
        <h2 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-3">
          {{ t('settings.profile.data.heading') }}
        </h2>
        <div class="border border-default rounded-lg px-4 py-4">
          <p class="font-serif text-base font-normal mb-1">
            {{ t('settings.profile.data.exportTitle') }}
          </p>
          <p class="text-sm text-muted mb-4">
            {{ t('settings.profile.data.exportDescription') }}
          </p>
          <div class="flex items-center gap-3 mb-4">
            <UButton
              color="neutral"
              :loading="requestingExport"
              :disabled="hasActiveExport || deletionPending"
              icon="i-lucide-package"
              data-testid="export-request-button"
              @click="onRequestExport"
            >
              {{ t('settings.profile.data.exportButton') }}
            </UButton>
            <span
              v-if="hasActiveExport"
              class="text-xs text-muted font-mono"
            >
              {{ t('settings.profile.data.exportInProgress') }}
            </span>
          </div>

          <h3 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
            {{ t('settings.profile.data.exportHistoryHeading') }}
          </h3>
          <div
            v-if="exportsLoading"
            class="text-sm text-muted"
          >
            <UIcon
              name="i-lucide-loader-2"
              class="size-4 animate-spin inline mr-2"
            />
            Loading…
          </div>
          <div
            v-else-if="exports.length === 0"
            class="text-sm text-muted font-mono"
          >
            {{ t('settings.profile.data.exportHistoryEmpty') }}
          </div>
          <ul
            v-else
            class="space-y-2"
          >
            <li
              v-for="job in exports"
              :key="job.jobId"
              class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border border-default rounded-md px-3 py-3"
              data-testid="export-history-row"
            >
              <!-- Metadata stack. On mobile each fact lives on its
                   own line with a tiny mono label so the user can
                   tell "requested" from "available until" — earlier
                   the two dates ran together with no separator and
                   were visually conflated. On desktop the layout
                   compresses to one row. -->
              <div class="text-xs flex-1 min-w-0 space-y-0.5">
                <div class="flex items-center gap-2 flex-wrap">
                  <span
                    class="font-mono uppercase tracking-wider"
                    :class="{
                      'text-rose-700 dark:text-rose-300': job.status === 'failed',
                      'text-muted': job.status !== 'failed' && job.status !== 'ready',
                      'text-default': job.status === 'ready'
                    }"
                  >
                    {{ job.status }}
                  </span>
                  <span
                    v-if="job.sizeBytes"
                    class="font-mono text-muted"
                  >
                    {{ fmtBytes(job.sizeBytes) }}
                  </span>
                </div>
                <div class="flex flex-col sm:flex-row sm:gap-3 text-muted font-mono">
                  <span>
                    <span class="uppercase tracking-wider">requested</span>
                    {{ fmtDate(job.createdAt) }}
                  </span>
                  <span v-if="job.expiresAt && job.status === 'ready'">
                    <span class="uppercase tracking-wider">available until</span>
                    {{ fmtDate(job.expiresAt) }}
                  </span>
                </div>
                <div
                  v-if="job.errorMessage"
                  class="text-rose-700 dark:text-rose-300 truncate"
                >
                  {{ job.errorMessage }}
                </div>
              </div>
              <UButton
                v-if="job.downloadable"
                size="sm"
                color="neutral"
                variant="outline"
                icon="i-lucide-download"
                block
                class="sm:!w-auto sm:!self-center shrink-0"
                :to="`/api/user/exports/${job.jobId}/download`"
                external
                data-testid="export-download-button"
              >
                {{ t('settings.profile.data.exportDownload') }}
              </UButton>
            </li>
          </ul>
        </div>
      </section>

      <!-- Delete account — last because it's the most destructive. -->
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
            size="sm"
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

      <!-- Legal — secondary content; lists accepted document versions
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
                   1. Document accepted at the current version → show v + locale.
                   2. DPA not yet relevant (workspace-owner only) → show contextual hint, no rose warning.
                   3. Document needs acceptance → "Not accepted" + rose re-acceptance flag. -->
              <span v-if="row.state.acceptedVersion !== null">
                v{{ row.state.acceptedVersion }}<span v-if="row.state.acceptedLocale"> · {{ row.state.acceptedLocale }}</span>
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
          class="text-xs text-muted mt-3"
          data-testid="profile-cookie-note"
        >
          {{ t('settings.profile.legal.cookieNote') }}
        </p>
      </section>
    </main>

    <CommonLegalFooter />

    <LegalAccountDeletionConsequencesModal
      v-model:open="deletionModalOpen"
      @scheduled="onDeletionScheduled"
    />
  </div>
</template>
