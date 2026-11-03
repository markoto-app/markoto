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

// The bar's height, published as `--mk-consent-h` on <html> while it is
// open, so pages can keep their content above it (the product page
// shortens its sticky stage and pads its end; see ProductTour.vue).
const barEl = ref<HTMLElement | null>(null)
let barObserver: ResizeObserver | null = null
function publishHeight(px: number): void {
  if (px > 0) document.documentElement.style.setProperty('--mk-consent-h', `${Math.ceil(px)}px`)
  else document.documentElement.style.removeProperty('--mk-consent-h')
}
watch(barEl, (el) => {
  barObserver?.disconnect()
  barObserver = null
  if (!el) {
    publishHeight(0)
    return
  }
  barObserver = new ResizeObserver(() => publishHeight(el.offsetHeight))
  barObserver.observe(el)
  publishHeight(el.offsetHeight)
})
onBeforeUnmount(() => {
  barObserver?.disconnect()
  publishHeight(0)
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
    <!-- A compact bar across the bottom: it informs and asks without
         covering the page (no cookie wall). Reject all and Accept all
         are the same size and weight (CNIL / EDPB); Customize is the
         quieter third option, a link beside the privacy-policy link, and
         opens the per-purpose switches. -->
    <dialog
      v-if="open"
      open
      class="consent-overlay"
      :aria-label="t('legal.consent.banner.title')"
      data-testid="consent-banner"
    >
      <div
        ref="barEl"
        class="consent-bar"
      >
        <div class="consent-bar__inner">
          <div class="consent-bar__text">
            <h2 class="consent-bar__title font-serif text-base font-normal tracking-tight">
              {{ t('legal.consent.banner.title') }}
            </h2>
            <p class="text-xs leading-relaxed text-muted">
              <!-- Phones get the short intro (the full one is on the
                   privacy page and in the Customize panel). -->
              <span class="consent-bar__intro">{{ t('legal.consent.banner.intro') }}</span>
              <span class="consent-bar__intro-short">{{ t('legal.consent.banner.introShort') }}</span>
              {{ ' ' }}
              <NuxtLink
                to="/legal/privacy"
                class="consent-bar__link font-mono underline hover:text-default"
              >
                {{ t('legal.consent.banner.learnMore') }}
              </NuxtLink>
              <template v-if="!customizing">
                <span aria-hidden="true"> · </span>
                <button
                  type="button"
                  class="consent-bar__link font-mono underline hover:text-default"
                  data-testid="consent-customize"
                  @click="startCustomize"
                >
                  {{ t('legal.consent.banner.customize') }}
                </button>
              </template>
            </p>
          </div>

          <div class="consent-bar__actions">
            <UButton
              color="neutral"
              variant="outline"
              :loading="submitting"
              class="consent-bar__choice"
              data-testid="consent-reject-all"
              @click="rejectAll"
            >
              {{ t('legal.consent.banner.rejectAll') }}
            </UButton>
            <UButton
              v-if="customizing"
              color="neutral"
              :loading="submitting"
              class="consent-bar__choice"
              data-testid="consent-save"
              @click="saveCustom"
            >
              {{ t('legal.consent.banner.save') }}
            </UButton>
            <UButton
              v-else
              color="neutral"
              :loading="submitting"
              class="consent-bar__choice"
              data-testid="consent-accept-all"
              @click="acceptAll"
            >
              {{ t('legal.consent.banner.acceptAll') }}
            </UButton>
          </div>
        </div>

        <!-- Customize panel: granular per-purpose toggles. Hidden
             until the user clicks "Customize". No pre-ticked boxes. -->
        <div
          v-if="customizing"
          class="consent-bar__panel"
          data-testid="consent-customize-panel"
        >
          <p class="text-xs text-muted font-mono sm:col-span-3">
            {{ t('legal.consent.banner.essentialNotice') }}
          </p>
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
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.consent-overlay {
  /* Not modal: the page underneath stays readable and scrollable
     (CNIL: no cookie wall). The dialog box itself is reset; the bar
     inside it takes the clicks. */
  position: fixed;
  inset: auto 0 0 0;
  z-index: 60;
  width: 100%;
  max-width: none;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  pointer-events: none;
}
.consent-bar {
  pointer-events: auto;
  max-height: 80svh;
  overflow-y: auto;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg);
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
}
.consent-bar__inner {
  max-width: 72rem;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.consent-bar__text { min-width: 0; }
/* Phones: a slim bar — no heading (the dialog keeps it as its label), the
   short intro, the two equal choices side by side. */
.consent-bar__title,
.consent-bar__intro { display: none; }
.consent-bar__link {
  /* An inline link, padded to a comfortable tap target. */
  display: inline-block;
  padding-block: 6px;
  margin-block: -6px;
  cursor: pointer;
}
.consent-bar__actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.consent-bar__choice {
  justify-content: center;
  min-height: 44px;
}
.consent-bar__panel {
  max-width: 72rem;
  margin: 12px auto 0;
  padding-top: 12px;
  border-top: 1px solid var(--ui-border);
  display: grid;
  gap: 12px;
}
@media (min-width: 640px) {
  .consent-bar__title { display: block; }
  .consent-bar__intro { display: inline; }
  .consent-bar__intro-short { display: none; }
  .consent-bar { padding: 12px 24px; }
  .consent-bar__inner {
    flex-direction: row;
    align-items: center;
    gap: 24px;
  }
  .consent-bar__text { flex: 1; }
  .consent-bar__actions {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .consent-bar__choice { min-width: 7.5rem; }
  .consent-bar__panel { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
/* Short viewports (phones in landscape): the compact text, one row. */
@media (min-width: 640px) and (max-height: 520px) {
  .consent-bar { padding-block: 8px; }
  .consent-bar__title,
  .consent-bar__intro { display: none; }
  .consent-bar__intro-short { display: inline; }
}
</style>
