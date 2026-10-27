<script setup lang="ts">
import WaveformVisualizer from './WaveformVisualizer.vue'

const props = defineProps<{
  ai: {
    mySession: ReturnType<typeof useAI>['mySession']
    mySessionId: ReturnType<typeof useAI>['mySessionId']
    otherSessions: ReturnType<typeof useAI>['otherSessions']
    submitting: ReturnType<typeof useAI>['submitting']
    lastError: ReturnType<typeof useAI>['lastError']
    budgetExhausted: ReturnType<typeof useAI>['budgetExhausted']
    lastResponse: ReturnType<typeof useAI>['lastResponse']
    pendingConfirmation: ReturnType<typeof useAI>['pendingConfirmation']
    answeringConfirmation: ReturnType<typeof useAI>['answeringConfirmation']
    answerConfirmation: ReturnType<typeof useAI>['answerConfirmation']
    prompt: ReturnType<typeof useAI>['prompt']
    abort: ReturnType<typeof useAI>['abort']
    clearLastError: ReturnType<typeof useAI>['clearLastError']
  }
}>()

const { t } = useI18n()
const { loggedIn } = useUserSession()
const toast = useToast()
// Mobile haptic confirming the abort tap landed — slightly longer
// pulse than a casual click because aborting an in-flight AI session
// is a deliberate "stop this" action. Silent no-op on iOS. Pattern
// passed at call time because UseVibrateOptions.interval is
// non-optional in the upstream .d.ts.
const { vibrate: vibrateAbort } = useVibrate()

// Billing state — drives two things in the prompt bar:
//   1. `refreshBilling` is called after a session ends so the topbar
//      badge's percentage ticks down live.
//   2. `creditsExhausted` gates the input + send + mic buttons so the
//      user can't even type a prompt that the server would reject.
//      The bar stays visible so the user sees the path forward.
const { refresh: refreshBilling } = useBilling()
// Phase 6: AI exhaustion comes from /api/ai/credits (LiteLLM /key/info).
// `refreshAiCredits` runs after a session ends so the AI Points badge
// ticks down live without the user navigating away.
const { isExhausted: pointsExhausted, isWorkspaceShared: creditsAreShared, refresh: refreshAiCredits } = useAiCredits()
// Bring your own key (WP4): which capabilities this user can use, and
// whether chat is paid by the platform. AI Points only gate the bar when
// chat actually spends them — a user on their own key is never blocked
// by an empty platform budget.
const { chatMissing, transcriptionAvailable, chatPlatformBilled } = useAiAvailability()
const creditsExhausted = computed(() => chatPlatformBilled.value && pointsExhausted.value)
const { billingEnabled, plansComingSoon, pricingVisible } = useBillingMode()
const router = useRouter()

const input = ref('')
const inputEl = ref<HTMLInputElement | null>(null)
// `useFocus` exposes a writable computed boolean; setting it would
// trigger focus()/blur() on the element. We only read it here — the
// focused state drives the `is-focused` shell class for the focus
// ring + glow CSS.
const { focused } = useFocus(inputEl)

// Voice input state machine. On a successful transcription we land the
// text in the input field briefly (so the user sees what we heard) and
// then auto-submit it as a normal AI prompt. The brief on-screen flash
// is intentional — silent auto-submit feels like a black box when the
// model mishears.
const voice = useVoicePrompt({
  onTranscript: async (text) => {
    input.value = text
    // Tiny pause so the transcribed text is visible before submit clears
    // the input. Chosen by feel — any shorter and it looks like nothing
    // happened, any longer and the user starts to edit.
    await new Promise(resolve => setTimeout(resolve, 150))
    const ok = await props.ai.prompt(text)
    if (ok) input.value = ''
  },
  onInaudible: () => {
    toast.add({
      title: t('ai.micInaudibleTitle'),
      description: t('ai.micInaudibleDescription'),
      icon: 'i-lucide-mic-off',
      color: 'warning'
    })
  }
})

// Show voice errors as a toast — same UX as regular AI errors. `clearError`
// resets the composable so the button isn't stuck showing an error icon.
watch(() => voice.errorMessage.value, (err) => {
  if (!err) return
  toast.add({
    title: t('ai.micErrorTitle'),
    description: err,
    icon: 'i-lucide-alert-circle',
    color: 'error'
  })
  voice.clearError()
})

const placeholder = computed(() => {
  if (!loggedIn.value) return t('ai.loginRequired')
  if (chatMissing.value) return t('aiProvider.cta.promptBar')
  // Out of credits → swap the placeholder so the user reads the
  // reason the bar is disabled + the path forward. Workspace-shared
  // pool exhaustion gets its own copy because the path forward is
  // "contact the workspace owner", not /pricing.
  if (creditsExhausted.value) {
    if (creditsAreShared.value) return t('ai.workspaceExhaustedPlaceholder')
    return billingEnabled.value ? t('ai.exhaustedPlaceholder') : t('ai.exhaustedPlaceholderFree')
  }
  // Active session → mirror the session's status message. Bar doubles
  // as a status indicator so the user knows the AI isn't stuck.
  const s = props.ai.mySession.value
  if (s) return s.message || t('ai.statusThinking')
  // Idle → primary call-to-action copy. The bar is the entry point
  // for the AI — usage/remaining info lives in the topbar badge where
  // it doesn't compete with the affordance.
  return t('ai.placeholder')
})

// At-cap click → /pricing instead of a doomed request. Used by the
// send button's click handler and by click-on-input (for users who
// click the grayed-out bar and expect *something* to happen).
// Skip the redirect when the exhausted pool is workspace-shared —
// the member has nothing to upgrade; the toast already told them
// to contact the owner.
function onCapReached() {
  if (creditsAreShared.value) return
  if (pricingVisible.value) {
    router.push('/pricing')
    return
  }
  // Self-hosted: nothing to buy — re-explain instead of a dead link.
  showPersonalBudgetToast()
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

// After a session ends, refresh the billing counter so the topbar
// usage badge ticks down live.
watch(() => props.ai.mySessionId.value, (now, prev) => {
  if (prev && !now) {
    void refreshBilling()
    void refreshAiCredits()
  }
})

// Phase 7: when the runLoop's mid-loop catch path fires (a
// LitellmBudgetExhausted from the proxy), the prompt request itself
// returned 200 — there's no `budgetExhausted` flip on `useAI`. The
// session-end refresh above pulls the new credit numbers; this watch
// reacts to the false→true transition and surfaces the upgrade toast
// the user would otherwise miss.
watch(creditsExhausted, (now, prev) => {
  if (now && !prev) {
    // Workspace-shared (+) pool exhausted — the member CAN'T fix this
    // by upgrading themselves; only the workspace owner's plan / spend
    // matters. Swap copy + drop the upgrade CTA so we don't push them
    // onto a self-pricing page that won't help.
    if (creditsAreShared.value) {
      toast.add({
        title: t('ai.workspaceBudgetExhaustedTitle'),
        description: t('ai.workspaceBudgetExhaustedDescription'),
        icon: 'i-lucide-credit-card',
        color: 'warning'
      })
      return
    }
    showPersonalBudgetToast()
  }
})

const disabled = computed(() => {
  return !loggedIn.value
    || chatMissing.value
    || !!props.ai.mySessionId.value
    || props.ai.submitting.value
    || creditsExhausted.value
})

const aiSettingsRoute = AI_SETTINGS_ROUTE
function goToAiSettings(): void {
  void router.push(aiSettingsRoute)
}

// Voice UI is mutually exclusive with the text input; each voice state
// maps to one of four display modes for the middle slot of the bar.
const isRecording = computed(() => voice.state.value === 'recording')
const isTranscribing = computed(() => voice.state.value === 'transcribing')
const isRequestingPerm = computed(() => voice.state.value === 'requesting-permission')
const voiceActive = computed(() => isRecording.value || isTranscribing.value || isRequestingPerm.value)

// The mic button is hidden during an active AI session (the stop button
// takes its slot). It's also disabled when the user is mid-submit, when
// they're not logged in (transcribe is protected), or when the mic is
// explicitly blocked at the browser-permission level (no point letting
// the user click and hit a NotAllowedError).
const micPermissionDenied = computed(() => voice.micPermission.value === 'denied')
const micDisabled = computed(() => {
  return !loggedIn.value
    || !!props.ai.mySessionId.value
    || props.ai.submitting.value
    || creditsExhausted.value
    || micPermissionDenied.value
})
const micTitle = computed(() => {
  if (micPermissionDenied.value) return t('ai.micBlocked')
  return t('ai.micStart')
})

// Timer display ticks with `durationSec` (updated by the composable's RAF
// loop). MM:SS is enough — voice input caps at 60s so minutes are always 0
// or 1 but the format stays familiar.
const formattedTime = computed(() => {
  const s = Math.max(0, Math.floor(voice.durationSec.value))
  const mm = String(Math.floor(s / 60)).padStart(1, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
})

// Amber at the last 10s, red at the last 5s — gives the user a moment
// to wrap up before the hard auto-stop fires.
const timerColorClass = computed(() => {
  const remaining = voice.maxDurationSec - voice.durationSec.value
  if (remaining <= 5) return 'text-red-500'
  if (remaining <= 10) return 'text-amber-500'
  return 'text-muted'
})

async function onSubmit() {
  // Exhausted users get routed to /pricing instead of a silent no-op.
  // `disabled.value` includes `creditsExhausted`, so the body below
  // guards against the rest of the disabled states (no session, not
  // logged in, etc).
  if (creditsExhausted.value) {
    onCapReached()
    return
  }
  const text = input.value.trim()
  if (!text || disabled.value) return
  const ok = await props.ai.prompt(text)
  if (ok) input.value = ''
}

watch(() => props.ai.lastError.value, (err) => {
  if (!err) return
  if (props.ai.budgetExhausted.value) {
    // Dedicated budget-exhausted toast with an Upgrade action. Users
    // need an obvious path forward — a generic "AI request failed"
    // toast doesn't tell them what to do.
    if (creditsAreShared.value) {
      toast.add({
        title: t('ai.workspaceBudgetExhaustedTitle'),
        description: t('ai.workspaceBudgetExhaustedDescription'),
        icon: 'i-lucide-credit-card',
        color: 'warning'
      })
      return
    }
    showPersonalBudgetToast()
  } else {
    toast.add({
      title: t('ai.failed'),
      description: err,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  }
  props.ai.clearLastError()
})

// Other people's sessions: only who it is for — their prompt and the
// AI's status text are private to them.
const otherSessionsTooltip = computed(() =>
  props.ai.otherSessions.value.map(s => t('ai.otherSessionWorking', { name: s.initiatorName })).join('\n')
)

async function onStop() {
  vibrateAbort(150)
  await props.ai.abort()
}

// Phase-to-icon mapping for the active-session status icon
const statusIcon = computed(() => {
  const phase = props.ai.mySession.value?.phase
  switch (phase) {
    case 'thinking': return 'i-lucide-brain'
    case 'tool': return 'i-lucide-wrench'
    case 'editing': return 'i-lucide-pencil'
    case 'error': return 'i-lucide-alert-circle'
    case 'done': return 'i-lucide-check-circle'
    // Fallback: pulsing-circle for any unknown active phase. The
    // brand reserves the seal for the brand mark itself; here we
    // just need a "still working" glyph.
    default: return 'i-lucide-loader'
  }
})

// Bottom bar animates whenever there's an active session for the
// caller. The bottom bar and the selection popup both point at
// the same session — having both surfaces animate in sync reinforces
// "AI is working" rather than competing for attention.
const isActive = computed(() => !!props.ai.mySession.value)

// True when the response panel is showing in its expanded card form
// (not the small "last response" pill). Drives the wrapper's
// `.has-response` class so CSS can collapse the gap between the panel
// and the bar shell, and round only the touching corners. Mirrored
// from the panel's own `update:expanded` emit so the wrapper class
// stays in lockstep with what the panel is actually showing
// (including hover-pause). A previous version ran a duplicate timer
// here which fell out of sync as soon as the panel paused on hover.
const hasResponseExpanded = ref(false)
function onPanelExpandedChange(v: boolean) {
  hasResponseExpanded.value = v
}

// Virtual-keyboard awareness — without this the bar gets shoved
// off-screen on mobile when the keyboard pops up. We watch the
// `visualViewport` API for keyboard intrusion and offset the bar's
// `bottom: <px>` to sit just above it. Desktop fallback: 24px (the
// existing `bottom-6` value).
const keyboardOffset = ref(0)

function updateKeyboardOffset() {
  if (globalThis.window === undefined || !globalThis.visualViewport) return
  const vv = window.visualViewport
  const gap = window.innerHeight - vv.height - vv.offsetTop
  keyboardOffset.value = gap > 80 ? gap : 0
}

// On mobile (<sm) the bottom MobileTabBar sits at the very bottom of
// the viewport. ~56px tall (24px icon + 12px label + ~12px vertical
// padding + safe-area-inset-bottom). We add that to the AI-prompt-
// bar's bottom offset so the two never overlap. Recomputed reactively
// from the same media query the tab bar uses. Desktop returns 0 —
// the tab bar isn't mounted there.
const isMobile = useMediaQuery('(max-width: 639px)')
const FORMAT_BAR_HEIGHT_PX = 56

const bottomOffset = computed(() => {
  const formatBarOffset = isMobile.value ? FORMAT_BAR_HEIGHT_PX : 0
  if (keyboardOffset.value > 0) {
    // Keyboard is up → sit just above the keyboard. The MobileFormatBar
    // is also re-anchored above the keyboard (via the same offset), so
    // we still need to clear it.
    return `${keyboardOffset.value + formatBarOffset + 8}px`
  }
  // Keyboard down → sit above the format bar (mobile) or the
  // standard 24px gap (desktop).
  return formatBarOffset > 0 ? `${formatBarOffset + 8}px` : '24px'
})

onMounted(() => {
  if (globalThis.window === undefined || !globalThis.visualViewport) return
  window.visualViewport.addEventListener('resize', updateKeyboardOffset)
  window.visualViewport.addEventListener('scroll', updateKeyboardOffset)
  updateKeyboardOffset()
})

onUnmounted(() => {
  if (globalThis.window === undefined || !globalThis.visualViewport) return
  window.visualViewport.removeEventListener('resize', updateKeyboardOffset)
  window.visualViewport.removeEventListener('scroll', updateKeyboardOffset)
})
</script>

<template>
  <!-- Floating AI bar. Sits above the bottom edge of the editor +
       preview area, centered and prominent. Pill shape, frosted
       backdrop, SHU accent ring + soft glow so it reads as "AI
       surface" — shu means AI presence in this product, and the
       prompt bar is the AI's primary entry point. The ring is the
       brand's most prominent shu surface. -->
  <div
    class="ai-prompt-bar pointer-events-none absolute inset-x-0 z-20 flex flex-col items-center px-4"
    :class="{ 'is-focused': focused, 'is-active': isActive, 'has-response': hasResponseExpanded }"
    :style="{ bottom: bottomOffset }"
    data-testid="ai-prompt-bar"
    :data-active="isActive ? 'true' : 'false'"
  >
    <!-- Ephemeral response panel — driven by `useAI`'s latched
         `lastResponse`. When expanded, it visually merges into the
         prompt bar shell below (single floating section). When
         collapsed it floats as a separate pill above the bar. -->
    <!-- Allow / Deny for a cross-document, knowledge or web action the
         AI wants to take after reading other people's text. Private to
         the initiator (session channel), never broadcast. -->
    <AIConfirmPanel
      :request="props.ai.pendingConfirmation.value"
      :busy="props.ai.answeringConfirmation.value"
      @allow="props.ai.answerConfirmation(true)"
      @deny="props.ai.answerConfirmation(false)"
    />
    <AIResponsePanel
      :response="props.ai.lastResponse.value"
      class="ai-prompt-bar__response"
      @update:expanded="onPanelExpandedChange"
    />
    <div
      class="ai-prompt-bar__shell pointer-events-auto w-full max-w-3xl flex items-center gap-0 rounded-full pl-5 pr-0 py-0 backdrop-blur-md transition-all"
    >
      <!-- Leading sparkle / live status icon. Bigger than a typical
           toolbar icon to anchor the bar visually; pulses gently while
           a session is in flight. Stays the same through voice states —
           we want the prompt bar to feel the same regardless of whether
           the user is typing or speaking; only the middle slot changes. -->
      <!-- Idle state: the brand seal stands in for the old sparkle —
           the design system bans AI-sparkle iconography ("the seal is
           the AI's mark; it does not need a sparkle"). Active states
           keep their phase-specific lucide icons in shu. -->
      <CommonSeal
        v-if="!isActive"
        :size="14"
        class="shrink-0 mr-3"
      />
      <UIcon
        v-else
        :name="statusIcon"
        :class="[
          'size-5 shrink-0 mr-3 transition-colors text-primary',
          'animate-pulse'
        ]"
      />

      <!-- Middle slot: text input, waveform, or a transient label. The
           three voice-state branches sit above the normal `<input>` via
           `v-if`/`v-else-if` chain so only one mounts at a time — keeps
           a11y simple and prevents the input from absorbing keystrokes
           while the user is mid-recording. -->
      <!-- `py-2` (not `py-3` like the text input) compensates for the
           32px waveform canvas: 8 + 32 + 8 = 48 px matches the text
           input's 12 + 24 (line-height) + 12 exactly, so the pill
           doesn't grow vertically when the user toggles the mic. -->
      <div
        v-if="isRecording"
        class="flex-1 min-w-0 flex items-center gap-3 py-2"
      >
        <WaveformVisualizer
          :levels="voice.levels.value"
          :height="32"
          class="flex-1 min-w-0"
        />
        <span
          class="voice-timer text-sm tabular-nums font-medium shrink-0"
          :class="timerColorClass"
        >{{ formattedTime }}</span>
      </div>
      <div
        v-else-if="isTranscribing"
        class="flex-1 min-w-0 flex items-center py-3"
      >
        <span class="text-muted italic transcribing-shimmer">{{ t('ai.micTranscribing') }}</span>
      </div>
      <div
        v-else-if="isRequestingPerm"
        class="flex-1 min-w-0 flex items-center py-3"
      >
        <span class="text-muted italic">{{ t('ai.micRequestingPermission') }}</span>
      </div>
      <!-- AI prompt input wears the editorial italic-serif voice —
           Fraunces italic 400, slightly larger than the rest of the
           chrome. The brand reserves italic-serif for "the AI is
           speaking" moments; treating the input itself as a voice
           channel to the AI extends that moment to the user side
           of the conversation. Both placeholder and typed text
           inherit the family. -->
      <!-- No chat provider (bring your own key, nothing configured and no
           instance default): the bar becomes the call-to-action instead
           of an input that would only fail. -->
      <NuxtLink
        v-else-if="loggedIn && chatMissing"
        :to="aiSettingsRoute"
        class="flex-1 min-w-0 py-3 text-sm text-muted hover:text-default transition-colors truncate"
        data-testid="ai-prompt-bar-provider-cta"
      >
        {{ t('aiProvider.cta.promptBar') }}
      </NuxtLink>
      <input
        v-else
        ref="inputEl"
        v-model="input"
        type="text"
        :placeholder="placeholder"
        :aria-label="t('ai.placeholder')"
        :disabled="disabled"
        class="flex-1 min-w-0 bg-transparent outline-none font-serif italic text-[17px] tracking-tight placeholder:text-muted disabled:text-muted py-3 pr-0"
        data-testid="ai-prompt-bar-input"
        @keydown.enter="onSubmit"
      >

      <!-- Other-sessions indicator — kept compact so the bar doesn't
           grow visually when collaborators are also asking the AI. -->
      <UTooltip
        v-if="ai.otherSessions.value.length > 0 && !voiceActive"
        :text="otherSessionsTooltip"
      >
        <UBadge
          color="info"
          variant="subtle"
          size="sm"
          class="rounded-full mr-2"
        >
          <UIcon
            name="i-lucide-users"
            class="size-3 mr-1"
          />
          {{ ai.otherSessions.value.length }}
        </UBadge>
      </UTooltip>

      <!-- Secondary slot: mic button (idle) or cancel × (during voice
           capture). Same physical location keeps the bar visually stable —
           only the icon + meaning flip. During transcription the slot
           still holds the cancel × so the user has an escape hatch
           while the spinner spins on the primary slot. -->
      <UButton
        v-if="!isActive && (isRecording || isTranscribing)"
        color="neutral"
        variant="ghost"
        icon="i-lucide-x"
        :aria-label="t('ai.micCancel')"
        class="ai-prompt-bar__secondary"
        @click="voice.cancel()"
      />
      <UButton
        v-else-if="!isActive && transcriptionAvailable && !chatMissing"
        color="neutral"
        variant="ghost"
        :icon="micPermissionDenied ? 'i-lucide-mic-off' : 'i-lucide-mic'"
        :disabled="micDisabled"
        :aria-label="micTitle"
        :title="micTitle"
        data-testid="ai-prompt-bar-mic"
        class="ai-prompt-bar__secondary"
        @click="voice.toggle()"
      />

      <!-- Primary slot: send. Stays blue across idle + recording so the
           bar doesn't visually shift when the user starts speaking —
           only the input area swaps to the waveform. Clicking during
           recording stops the mic, which triggers transcription + auto-
           submit via the composable's state machine. During transcription
           the button shows a spinner and is disabled; cancel (×) in the
           secondary slot is the only escape. -->
      <UButton
        v-if="!isActive && isRecording"
        color="primary"
        icon="i-lucide-send"
        :aria-label="t('ai.micStop')"
        class="ai-prompt-bar__action"
        @click="voice.stop()"
      />
      <UButton
        v-else-if="!isActive && isTranscribing"
        color="primary"
        :loading="true"
        :disabled="true"
        :aria-label="t('ai.micTranscribing')"
        class="ai-prompt-bar__action"
      />
      <!--
        Send button. When credits are exhausted we do NOT disable it
        — the click routes to /pricing instead, keeping the escape
        hatch alive so the user can't get stuck. The primary color
        here is shu (red); invoking the AI is the one place where a
        call-to-action SHOULD wear the seal.
      -->
      <UButton
        v-else-if="!isActive && loggedIn && chatMissing"
        color="neutral"
        icon="i-lucide-key-round"
        :aria-label="t('aiProvider.cta.openSettings')"
        :title="t('aiProvider.cta.openSettings')"
        data-testid="ai-prompt-bar-settings"
        class="ai-prompt-bar__action"
        @click="goToAiSettings"
      />
      <UButton
        v-else-if="!isActive"
        :color="creditsExhausted ? 'neutral' : 'primary'"
        :icon="creditsExhausted ? 'i-lucide-lock' : 'i-lucide-send'"
        :loading="ai.submitting.value"
        :disabled="!loggedIn || (!creditsExhausted && !input.trim())"
        :class="creditsExhausted ? 'opacity-70' : ''"
        :aria-label="creditsExhausted ? t('ai.exhaustedPlaceholder') : t('ai.send')"
        :title="creditsExhausted ? t('ai.exhaustedPlaceholder') : undefined"
        data-testid="ai-prompt-bar-send"
        class="ai-prompt-bar__action"
        @click="onSubmit"
      />
      <UButton
        v-else
        color="error"
        icon="i-lucide-square"
        :aria-label="t('ai.stop')"
        class="ai-prompt-bar__action"
        @click="onStop"
      />
    </div>
  </div>
</template>

<style scoped>
/*
 * AI surface treatment.
 *
 * - Light mode: white frosted background with a blue accent ring + soft
 *   glow. The ring is the primary AI-distinct visual cue ("not part of
 *   the doc"); the heavy drop shadow lifts the bar off the page.
 * - Dark mode: tinted dark background, slightly stronger ring opacity
 *   so the glow still reads against deep neutrals.
 * - On focus (input has caret) and during an active AI session, the
 *   ring tightens and the glow expands so the user gets clear "I'm
 *   composing" and "AI is doing something" affordances.
 *
 * Using inline classes for layout (Tailwind), inline styles for the
 * gradient/shadow stack — Tailwind's arbitrary-value escapes for
 * stacked shadows with color-mix become unreadable.
 */
.ai-prompt-bar__shell {
  /* Use `--ui-bg-muted` (sumi-50 in light, flat sumi-950 in dark) so
     the prompt bar shares the same warm chrome tone as the toolbar,
     status bar, and right sidebar — one continuous chrome field.
     Ring + glow colors are full-strength shu (the brand red). Earlier
     they sat at 38%/28% which drifted toward pink/coral. */
  background: color-mix(in srgb, var(--ui-bg-muted) 88%, transparent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--color-shu-500) 70%, transparent),
    0 14px 36px -12px color-mix(in srgb, var(--color-shu-500) 32%, transparent),
    0 8px 24px -8px rgb(20 17 13 / 0.15);
  /* Replace Tailwind's `rounded-full` (which emits
     `border-radius: calc(infinity * 1px)` in v4) with a FINITE value.
     The bar is ~48px tall, so 1.5rem (24px) === half-height ===
     visually identical to a pill, but transitions from 1.5rem → 0px
     are interpolatable in CSS. Transitioning from `infinity` to 0 is
     not — the browser can't draw an intermediate radius for a
     non-finite value, so the corner snaps at the very end of the
     transition window instead of morphing smoothly. Scoped CSS
     specificity (auto-added [data-v-…] selector) wins over the
     inline `rounded-full` utility class. */
  border-radius: 1.5rem;
  /* Override Tailwind's `transition-all` (150ms) with a longer curve
     specifically for `border-radius`. The radius shape-shift between
     all-pill (standalone) and flat-top-pill-bottom (merged with the
     response panel) needs more time than the default to feel
     intentional rather than snappy. Other animated properties
     (background, box-shadow color/blur for focus + active states) keep
     the original 150ms snap. The explicit `border-radius` entry comes
     LAST so it wins for that property; CSS's transition list resolves
     each property to its last definition. */
  transition:
    all 150ms cubic-bezier(0.4, 0, 0.2, 1),
    border-radius 220ms cubic-bezier(0.4, 0, 0.2, 1);
}

.dark .ai-prompt-bar__shell {
  background: color-mix(in srgb, var(--ui-bg-muted) 78%, transparent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--color-shu-400) 75%, transparent),
    0 14px 36px -12px color-mix(in srgb, var(--color-shu-400) 38%, transparent),
    0 8px 24px -8px rgb(0 0 0 / 0.5);
}

.ai-prompt-bar.is-focused .ai-prompt-bar__shell {
  box-shadow:
    0 0 0 1.5px color-mix(in srgb, var(--color-shu-500) 90%, transparent),
    0 18px 44px -12px color-mix(in srgb, var(--color-shu-500) 45%, transparent),
    0 8px 24px -8px rgb(20 17 13 / 0.18);
}

:global(.dark) .ai-prompt-bar.is-focused .ai-prompt-bar__shell {
  box-shadow:
    0 0 0 1.5px color-mix(in srgb, var(--color-shu-400) 90%, transparent),
    0 18px 44px -12px color-mix(in srgb, var(--color-shu-400) 50%, transparent),
    0 8px 24px -8px rgb(0 0 0 / 0.45);
}

/*
 * Active session — rainbow ring + pulsing glow.
 *
 * Two simultaneous animations drive the look:
 *   1. `ai-rainbow` — cycles hue 0→360 over 8s, linear, so the ring
 *      and glow drift through red → yellow → green → cyan → blue →
 *      magenta and back at a calm pace (fast cycling reads as anxious).
 *   2. `ai-pulse` — eases a 0→1 value up and down every 2.8s, used to
 *      breathe the ring thickness and the glow's blur + opacity so the
 *      bar feels "alive" rather than just a moving color wheel.
 *
 * Custom properties are declared via `@property` because CSS otherwise
 * treats unknown vars as opaque strings and refuses to interpolate
 * them. With the syntax declared, browsers tween numerically and the
 * box-shadow recomputes per frame.
 */
@property --ai-rainbow-hue {
  syntax: '<number>';
  inherits: false;
  initial-value: 0;
}
@property --mk-pulse {
  syntax: '<number>';
  inherits: false;
  initial-value: 0;
}

/* Active state breathing — single shu glow that fades in and out.
   Earlier this rotated through the full hue spectrum (rainbow ring),
   which contradicted the brand rule "shu means AI presence,
   nothing else." A pulsing shu shadow is the same affordance ("the
   bar is alive, working") in the brand's voice. */
@keyframes mk-pulse {
  0%, 100% { --mk-pulse: 0; }
  50%      { --mk-pulse: 1; }
}

.ai-prompt-bar.is-active .ai-prompt-bar__shell {
  animation: mk-pulse 2.4s ease-in-out infinite;
  --_p: var(--mk-pulse);

  box-shadow:
    /* Border ring — stays at the brand shu, thickness pulses 1.5 → 2.5 px */
    0 0 0 calc(1.5px + var(--_p) * 1px) color-mix(in srgb, var(--color-shu-500) calc(60% + var(--_p) * 25%), transparent),
    /* Outer glow — blur and opacity breathe; hue is locked to shu */
    0 calc(16px + var(--_p) * 12px) calc(40px + var(--_p) * 28px) -12px color-mix(in srgb, var(--color-shu-500) calc(35% + var(--_p) * 30%), transparent),
    /* Static warm-tinted drop shadow underneath */
    0 8px 24px -8px rgb(20 17 13 / 0.18);
}

:global(.dark) .ai-prompt-bar.is-active .ai-prompt-bar__shell {
  box-shadow:
    0 0 0 calc(1.5px + var(--_p) * 1px) color-mix(in srgb, var(--color-shu-400) calc(60% + var(--_p) * 25%), transparent),
    0 calc(16px + var(--_p) * 12px) calc(40px + var(--_p) * 28px) -12px color-mix(in srgb, var(--color-shu-400) calc(35% + var(--_p) * 30%), transparent),
    0 8px 24px -8px rgb(0 0 0 / 0.45);
}

/* Respect users who've asked for reduced motion — drop the animations
 * but keep the active state visually distinct via a static rainbow-y
 * tint so the AI cue still reads. */
@media (prefers-reduced-motion: reduce) {
  .ai-prompt-bar.is-active .ai-prompt-bar__shell {
    animation: none;
    box-shadow:
      0 0 0 2.5px color-mix(in srgb, var(--color-shu-500) 70%, transparent),
      0 20px 56px -12px color-mix(in srgb, var(--color-shu-500) 50%, transparent),
      0 8px 24px -8px rgb(20 17 13 / 0.18);
  }
}

/*
 * Transcribing shimmer — a subtle left-to-right gradient sweep on the
 * "Transcribing…" label so the UI reads as "working" without a full
 * spinner (the primary button already carries one).
 */
@keyframes transcribe-shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.transcribing-shimmer {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--ui-text-muted) 60%, transparent) 0%,
    var(--color-shu-500) 50%,
    color-mix(in srgb, var(--ui-text-muted) 60%, transparent) 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: transcribe-shimmer 2s linear infinite;
}

/*
 * Action button — perfect circle that hugs the input row's height.
 * UButton's own size/rounded utilities ship at the same specificity as
 * any utility class we'd put on the element, so the override here uses
 * `!important` to win unconditionally. Width / height are pinned at 40
 * px, matching the input's 40 px content row (the bar is 52 px tall =
 * 40 input + 12 padding) so the button reads as edge-to-edge inside
 * the pill.
 */
/* `:deep` is required because UButton renders the actual <button> as a
 * child-component root — scoped CSS attribute selectors otherwise miss
 * it. With :deep, the selector applies regardless of scope tagging. */
/* Match the input row's height exactly so the button is edge-to-edge
 * with the input — no white margin on top/bottom/right. The shell has
 * `py-0` + `pr-0`; the input is `py-3` (24 px padding) + ~24 px line
 * height = 48 px content row, so the button is 48 px square. */
.ai-prompt-bar__shell :deep(.ai-prompt-bar__action) {
  width: 3rem !important;          /* 48 px */
  height: 3rem !important;
  min-height: 3rem !important;
  padding: 0 !important;
  border-radius: 9999px !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  flex-shrink: 0 !important;
  gap: 0 !important;
}
.ai-prompt-bar__shell :deep(.ai-prompt-bar__action .iconify) {
  width: 1.25rem !important;       /* 20 px — proportional to the 48 px button */
  height: 1.25rem !important;
}

/*
 * Secondary button — mic (idle), cancel (×). Smaller + ghost so the
 * primary send button reads as the main action. Square-ish with
 * rounded corners to sit comfortably next to the round primary.
 */
.ai-prompt-bar__shell :deep(.ai-prompt-bar__secondary) {
  width: 2.25rem !important;       /* 36 px */
  height: 2.25rem !important;
  min-height: 2.25rem !important;
  padding: 0 !important;
  border-radius: 9999px !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  flex-shrink: 0 !important;
  margin-right: 0.375rem;            /* 6 px gap before the primary button */
  gap: 0 !important;
}
.ai-prompt-bar__shell :deep(.ai-prompt-bar__secondary .iconify) {
  width: 1.125rem !important;       /* 18 px */
  height: 1.125rem !important;
}

/*
 * Response panel ↔ shell merge.
 *
 * When the response panel is in its expanded card form (not the
 * collapsed pill), we want it to read as ONE floating section with the
 * prompt-bar shell below it: shared shu border ring, shared glow, no
 * visual gap. The pill (collapsed) keeps a small gap so it floats as a
 * separate chip.
 *
 * Mechanism: in `.has-response` the wrapper's gap is dropped, the panel
 * loses its bottom border + bottom radius, and the shell loses its top
 * radius. The shu ring is applied to the WRAPPER instead of each child
 * via a single box-shadow inset on the merged surface — paged.js style
 * (own-stylesheet rule) — so the ring wraps the whole stack as one.
 */
/*
 * Merged mode — panel + shell read as ONE floating section.
 *
 * Two prior bugs the rules below correct:
 *
 *   1. WIDTH MISMATCH. The shell wears its shu ring as an OUTSET 1px
 *      box-shadow that paints OUTSIDE its layout box; the panel had a
 *      `border` (1px inside the box-sizing box). Net visual extent:
 *      shell was 2px wider than panel, the merged section misaligned by
 *      a hairline on each side. Fix: drop panel's `border`, give it the
 *      SAME outset 1px shu shadow ring as the shell. Both surfaces now
 *      paint to the same outer extent and the seam is pixel-perfect.
 *
 *   2. CORNER MISMATCH. The shell was `rounded-full` (≈26px effective
 *      at this 52px height), I overrode only its TOP corners to 1.5rem
 *      (24px). Bottom corners stayed at the larger rounded-full clamp,
 *      so the bar's bottom curves looked subtly off vs. the panel's
 *      top. Fix: in merged mode, square ALL four shell corners to
 *      1.5rem too. The merged section becomes one consistently rounded
 *      rectangle. Outside merged mode, the shell stays pill.
 */

/* Light-mode panel ring + background in merged mode. Outset 1px shu
   ring matches the shell's exactly; soft top-glow gives the merged
   section depth without a doubled shadow at the seam. The bottom
   shadow is suppressed so the seam between panel and shell is clean. */
.ai-prompt-bar.has-response :deep(.ai-response-panel) {
  margin-bottom: 0;
  border: none;
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  border-top-left-radius: 1.5rem;
  border-top-right-radius: 1.5rem;
  background: color-mix(in srgb, var(--ui-bg-muted) 88%, transparent);
  box-shadow:
    /* Outset 1px shu ring — same recipe as the shell's static ring */
    0 0 0 1px color-mix(in srgb, var(--color-shu-500) 70%, transparent),
    /* Soft top glow — pulled UP so it doesn't bleed into the seam */
    0 -10px 22px -10px color-mix(in srgb, var(--color-shu-500) 28%, transparent);
  /* Trim padding-bottom so the merged section reads as one card with
     consistent vertical rhythm rather than panel-feels-tall + bar. */
  padding-bottom: 0.625rem;
}
.dark .ai-prompt-bar.has-response :deep(.ai-response-panel) {
  background: color-mix(in srgb, var(--ui-bg-muted) 78%, transparent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--color-shu-400) 75%, transparent),
    0 -10px 22px -10px color-mix(in srgb, var(--color-shu-400) 32%, transparent);
}

/* Merged mode — shell flattens its TOP corners (seam with the panel)
   and pins its BOTTOM corners to 1.5rem.
 *
 * Why a FIXED bottom-corner value instead of leaving the inline
 * `rounded-full` to inherit:
 *
 *   `border-radius: 9999px` only clamps to half-height when adjacent
 *   corners on the same edge are also large — CSS's per-corner clamp
 *   shares the edge length between the two corners on it. In the
 *   standalone pill (all four corners 9999px), the left edge's height
 *   is split evenly: top-left + bottom-left = height, so each becomes
 *   ~half-height (~24px at 48px tall). When we zero the top corners,
 *   the bottom-left has the WHOLE left edge to itself — its radius
 *   grows to a full quarter-circle of height-radius (≈48px), curving
 *   the bar's bottom-left from the bottom corner all the way up to
 *   where the top-left should be. Visually, the curve sweeps around
 *   the right-side send button too, clipping it.
 *
 *   Fixing both bottom corners at 1.5rem (24px — the same value the
 *   original pill clamped to at this height) preserves the bar's
 *   familiar "fully rounded ends" look while keeping the send button
 *   geometry intact. The merged section reads as one rounded
 *   rectangle: panel-top 1.5rem, bar-bottom 1.5rem, seam dead
 *   straight. */
.ai-prompt-bar.has-response .ai-prompt-bar__shell {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
  border-bottom-left-radius: 1.5rem;
  border-bottom-right-radius: 1.5rem;
}

/* Sticky-question variant: a thicker (2px) shu ring on the panel so the
   "we need your answer" cue carries through the merged surface. */
.ai-prompt-bar.has-response :deep(.ai-response-panel.is-question) {
  box-shadow:
    0 0 0 2px var(--color-shu-500),
    0 -12px 26px -10px color-mix(in srgb, var(--color-shu-500) 38%, transparent);
}
.dark .ai-prompt-bar.has-response :deep(.ai-response-panel.is-question) {
  box-shadow:
    0 0 0 2px var(--color-shu-400),
    0 -12px 26px -10px color-mix(in srgb, var(--color-shu-400) 45%, transparent);
}

/* Pill mode (collapsed) — float separately with a small gap so it
   reads as a distinct chip. The gap was dropped on the wrapper to
   support the merged case; restore it just for pill children via
   margin. */
.ai-prompt-bar:not(.has-response) :deep(.ai-response-pill) {
  margin-bottom: 0.5rem;
}
</style>
