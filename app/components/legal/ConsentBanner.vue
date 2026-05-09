<script setup lang="ts">
// Cookie / consent banner. Renders for anonymous + logged-in
// alike (ePrivacy is identity-agnostic).
//
// First-visit prompt + persistent re-open via the footer "Privacy
// choices" link. Three purposes:
//   - essential   (always on, not togglable)
//   - analytics   (Plausible — currently cookieless and arguably
//                  doesn't need consent under most readings of
//                  ePrivacy, but we ask anyway since the legal-
//                  bar matters more than the small UX cost)
//   - session_replay  (PostHog — definitely needs consent;
//                      records UI interactions)
//
// CNIL-grade design: "Reject all" button is as visually
// prominent as "Accept all", no pre-ticked boxes when the
// customize panel is open, refusal is remembered until the
// consent version is bumped, no cookie wall (the app stays
// fully usable without consent).

interface PurposeState {
  purpose: 'essential' | 'analytics' | 'session_replay'
  granted: boolean
  version: number
}
interface ConsentSummary {
  currentVersion: number
  promptRequired: boolean
  decisions: Record<string, PurposeState>
}

const route = useRoute()
const { t, locale } = useI18n()
const toast = useToast()

const open = ref(false)
const customizing = ref(false)
const submitting = ref(false)
const summary = ref<ConsentSummary | null>(null)

// Per-purpose checkbox state. essential is locked on (label-only).
const analyticsChecked = ref(false)
const sessionReplayChecked = ref(false)

// Suppress the banner on /legal/* routes — the consent banner
// references the privacy policy + the user came here to read it.
function isExemptRoute(path: string): boolean {
  return path.startsWith('/legal/')
}

// First-mount fetch. The banner shows ONLY if the server tells
// us a prompt is required (no row at the current version).
async function refreshConsent(): Promise<void> {
  try {
    summary.value = await $fetch<ConsentSummary>('/api/consent')
  } catch {
    // Network blip — leave summary null so the banner doesn't
    // show prematurely. Will retry next page-load.
  }
}

onMounted(async () => {
  await refreshConsent()
  if (summary.value?.promptRequired && !isExemptRoute(route.path)) {
    open.value = true
  }
})

// Watch route changes: if the banner was open and the user
// navigated to /legal/*, hide it; re-open when they navigate
// off. Mirrors the OnboardingGate pattern.
watch(() => route.path, (path) => {
  if (!summary.value?.promptRequired) return
  open.value = !isExemptRoute(path)
})

// Public re-open API for the footer "Privacy choices" link. The
// link emits a CustomEvent on `window` and we listen here. We
// could also make this work via Pinia or a shared composable; the
// CustomEvent route keeps the link a pure NuxtLink without
// importing component refs.
const REOPEN_EVENT = 'markoto:reopen-consent'
async function reopenFromFooter(): Promise<void> {
  // Re-fetch in case the user already accepted and we need to
  // pre-fill the toggles from the latest decisions.
  await refreshConsent()
  customizing.value = true
  open.value = true
  syncTogglesFromSummary()
}

function syncTogglesFromSummary(): void {
  const d = summary.value?.decisions
  if (!d) return
  analyticsChecked.value = d.analytics?.granted === true
  sessionReplayChecked.value = d.session_replay?.granted === true
}

onMounted(() => {
  globalThis.addEventListener(REOPEN_EVENT, reopenFromFooter)
})
onBeforeUnmount(() => {
  globalThis.removeEventListener(REOPEN_EVENT, reopenFromFooter)
})

async function submit(decisions: Array<{ purpose: 'essential' | 'analytics' | 'session_replay', granted: boolean }>): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  try {
    await $fetch('/api/consent', {
      method: 'POST',
      body: { decisions, locale: locale.value }
    })
    open.value = false
    await refreshConsent()
    // Tell other surfaces (the Profile page in particular) so they
    // can refresh their displayed consent state without a manual reload.
    globalThis.dispatchEvent(new CustomEvent('markoto:consent-updated'))
  } catch (e) {
    const err = e as { message?: string, data?: { message?: string } }
    toast.add({
      title: 'Could not save your privacy choices',
      description: err.data?.message ?? err.message ?? 'Try again',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    submitting.value = false
  }
}

function acceptAll(): void {
  void submit([
    { purpose: 'essential', granted: true },
    { purpose: 'analytics', granted: true },
    { purpose: 'session_replay', granted: true }
  ])
}
function rejectAll(): void {
  void submit([
    { purpose: 'essential', granted: true }, // essential is always on
    { purpose: 'analytics', granted: false },
    { purpose: 'session_replay', granted: false }
  ])
}
function saveCustom(): void {
  void submit([
    { purpose: 'essential', granted: true },
    { purpose: 'analytics', granted: analyticsChecked.value },
    { purpose: 'session_replay', granted: sessionReplayChecked.value }
  ])
}

function startCustomize(): void {
  customizing.value = true
  syncTogglesFromSummary()
}
</script>

<template>
  <Teleport to="body">
    <dialog
      v-if="open"
      open
      class="consent-overlay fixed inset-x-0 bottom-0 z-[60] p-4 sm:p-6"
      :aria-label="t('legal.consent.banner.title')"
      data-testid="consent-banner"
    >
      <div class="max-w-3xl mx-auto bg-default border border-default rounded-lg shadow-lg p-5 sm:p-6">
        <h2 class="font-serif text-xl font-normal tracking-tight mb-2">
          {{ t('legal.consent.banner.title') }}
        </h2>
        <p class="text-sm text-muted mb-3">
          {{ t('legal.consent.banner.intro') }}
        </p>
        <p class="text-xs text-muted font-mono mb-4">
          {{ t('legal.consent.banner.essentialNotice') }}
        </p>

        <!-- Customize panel: granular per-purpose toggles. Hidden
             until the user clicks "Customize". CNIL-grade: no
             pre-ticked boxes, equal-prominence buttons. -->
        <div
          v-if="customizing"
          class="space-y-3 border-t border-default pt-4 mb-4"
          data-testid="consent-customize-panel"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="flex-1">
              <p class="text-sm font-medium">
                {{ t('legal.consent.purpose.essential.label') }}
              </p>
              <p class="text-xs text-muted">
                {{ t('legal.consent.purpose.essential.description') }}
              </p>
            </div>
            <span class="text-xs text-muted font-mono shrink-0">always on</span>
          </div>
          <div class="flex items-start justify-between gap-3">
            <div class="flex-1">
              <p class="text-sm font-medium">
                {{ t('legal.consent.purpose.analytics.label') }}
              </p>
              <p class="text-xs text-muted">
                {{ t('legal.consent.purpose.analytics.description') }}
              </p>
            </div>
            <USwitch
              v-model="analyticsChecked"
              data-testid="consent-toggle-analytics"
              class="shrink-0"
            />
          </div>
          <div class="flex items-start justify-between gap-3">
            <div class="flex-1">
              <p class="text-sm font-medium">
                {{ t('legal.consent.purpose.session_replay.label') }}
              </p>
              <p class="text-xs text-muted">
                {{ t('legal.consent.purpose.session_replay.description') }}
              </p>
            </div>
            <USwitch
              v-model="sessionReplayChecked"
              data-testid="consent-toggle-session_replay"
              class="shrink-0"
            />
          </div>
        </div>

        <!-- CTA row. Reject + Accept get equal weight (CNIL-grade).
             "Customize" is a third option for users who want
             granular control. -->
        <div class="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-end">
          <NuxtLink
            to="/legal/privacy"
            class="text-xs font-mono text-muted hover:text-default underline mr-auto"
          >
            {{ t('legal.consent.banner.learnMore') }}
          </NuxtLink>

          <UButton
            v-if="!customizing"
            variant="ghost"
            color="neutral"
            block
            class="sm:!w-auto"
            data-testid="consent-customize"
            @click="startCustomize"
          >
            {{ t('legal.consent.banner.customize') }}
          </UButton>
          <UButton
            color="neutral"
            variant="outline"
            :loading="submitting"
            block
            class="sm:!w-auto"
            data-testid="consent-reject-all"
            @click="rejectAll"
          >
            {{ t('legal.consent.banner.rejectAll') }}
          </UButton>
          <UButton
            v-if="customizing"
            color="neutral"
            :loading="submitting"
            block
            class="sm:!w-auto"
            data-testid="consent-save"
            @click="saveCustom"
          >
            {{ t('legal.consent.banner.save') }}
          </UButton>
          <UButton
            v-else
            color="neutral"
            :loading="submitting"
            block
            class="sm:!w-auto"
            data-testid="consent-accept-all"
            @click="acceptAll"
          >
            {{ t('legal.consent.banner.acceptAll') }}
          </UButton>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.consent-overlay {
  /* Subtle backdrop dimming so the banner reads as "page-level
     prompt" without being modal — the page underneath stays
     readable + scrollable, matching CNIL's "no cookie wall"
     guidance. */
  pointer-events: none;
}
.consent-overlay > div {
  pointer-events: auto;
}
</style>
