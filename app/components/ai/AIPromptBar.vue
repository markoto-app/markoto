<script setup lang="ts">
import { aiStatusText } from '~/utils/ai/statusText'

const props = defineProps<{
  ai: {
    mySession: ReturnType<typeof useAI>['mySession']
    mySessionId: ReturnType<typeof useAI>['mySessionId']
    otherSessions: ReturnType<typeof useAI>['otherSessions']
    submitting: ReturnType<typeof useAI>['submitting']
    lastError: ReturnType<typeof useAI>['lastError']
    budgetExhausted: ReturnType<typeof useAI>['budgetExhausted']
    /** Optional so callers / tests that don't care can omit it. */
    freeAllowanceExhausted?: ReturnType<typeof useAI>['freeAllowanceExhausted']
    lastResponse: ReturnType<typeof useAI>['lastResponse']
    /** Optional so callers / tests that don't care can omit it. */
    lastOutcome?: ReturnType<typeof useAI>['lastOutcome']
    pendingConfirmation: ReturnType<typeof useAI>['pendingConfirmation']
    answeringConfirmation: ReturnType<typeof useAI>['answeringConfirmation']
    answerConfirmation: ReturnType<typeof useAI>['answerConfirmation']
    prompt: ReturnType<typeof useAI>['prompt']
    abort: ReturnType<typeof useAI>['abort']
    clearLastError: ReturnType<typeof useAI>['clearLastError']
    /** My delegated jobs on the document (awareness); optional for callers / tests without jobs. */
    myJobIds?: ReturnType<typeof useAI>['myJobIds']
  }
  /** The document: shows the progress of my delegated AI jobs (`AIJobPanel`) when set. */
  docId?: string
  /**
   * The document's workspace: inside a Team / Business workspace the AI
   * budget is the workspace's (member limit + team pool).
   */
  workspaceId?: string | null
  /** The document requires suggestions: the AI suggests whatever the switch says. */
  suggestForced?: boolean
}>()

/** The AI proposes its edits as suggestions (this tab's choice, starting from the user's setting). */
const aiSuggest = defineModel<boolean>('suggest', { default: false })

const { t } = useI18n()
const { loggedIn } = useUserSession()
const toast = useToast()
// Mobile haptic confirming the abort tap landed, slightly longer
// pulse than a casual click because aborting an in-flight AI session
// is a deliberate "stop this" action. Silent no-op on iOS. Pattern
// passed at call time because UseVibrateOptions.interval is
// non-optional in the upstream .d.ts.
const { vibrate: vibrateAbort } = useVibrate()

// Which capabilities this user can use (the budget notices read whether
// chat is paid by the platform).
const { chatMissing, transcriptionAvailable, transcriptionLocked } = useAiAvailability()
// Voice the platform offers but the paying plan doesn't include: the mic
// stays, locked, and explains the way forward.
const { explainLocked } = useAiLockedPrompt()

const input = ref('')
const inputEl = ref<HTMLInputElement | null>(null)
// `useFocus` exposes a writable computed boolean; setting it would
// trigger focus()/blur() on the element. We only read it here, the
// focused state drives the `is-focused` shell class for the focus
// ring + glow CSS.
const { focused } = useFocus(inputEl)

// Voice input state machine. On a successful transcription we land the
// text in the input field briefly (so the user sees what we heard) and
// then auto-submit it as a normal AI prompt. The brief on-screen flash
// is intentional: silent auto-submit feels like a black box when the
// model mishears.
const voice = useVoicePrompt({
  onTranscript: async (text) => {
    input.value = text
    // Tiny pause so the transcribed text is visible before submit clears
    // the input. Chosen by feel, any shorter and it looks like nothing
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

// Show voice errors as a toast, same UX as regular AI errors. `clearError`
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

// Billing state: the budget gates the input, send and mic buttons so the
// user can't type a prompt the server would reject (the bar stays visible
// to show the way forward), and the notices explain what ran out.
const { creditsExhausted, freePoolExhausted, creditsAreShared, isTeamBudgetExhausted, adminCanRefillWorkspace, canBuyPersonalPoints, billingEnabled, onCapReached, goToAiSettings } = useAiBudgetNotices(props.ai, () => props.workspaceId)

const placeholder = computed(() => {
  if (!loggedIn.value) return t('ai.loginRequired')
  if (chatMissing.value) return t('aiProvider.cta.promptBar')
  // Out of AI Points → swap the placeholder so the user reads the
  // reason the bar is disabled + the path forward. Workspace-shared
  // pool exhaustion gets its own copy because the path forward is the
  // workspace's billing (admins) or an admin (members), not /pricing.
  if (creditsExhausted.value) return exhaustedPlaceholder.value
  // Active session: mirror the session's status so the bar doubles as a
  // status indicator.
  const s = props.ai.mySession.value
  if (s) return aiStatusText(s, t)
  // Idle: call-to-action copy. Usage/remaining info lives in the topbar
  // badge so it doesn't compete with the affordance.
  return t('ai.placeholder')
})

const exhaustedPlaceholder = computed(() => {
  if (freePoolExhausted.value) return t('ai.freeAllowanceExhaustedPlaceholder')
  if (creditsAreShared.value) {
    if (!isTeamBudgetExhausted.value) return t('ai.memberLimitPlaceholder')
    return adminCanRefillWorkspace.value ? t('ai.workspaceExhaustedPlaceholderAdmin') : t('ai.workspaceExhaustedPlaceholder')
  }
  if (canBuyPersonalPoints.value) return t('ai.exhaustedPlaceholderPro')
  return billingEnabled.value ? t('ai.exhaustedPlaceholder') : t('ai.exhaustedPlaceholderFree')
})

const disabled = computed(() => {
  return !loggedIn.value
    || chatMissing.value
    || !!props.ai.mySessionId.value
    || props.ai.submitting.value
    || creditsExhausted.value
})

const aiSettingsRoute = AI_SETTINGS_ROUTE

// Voice UI is mutually exclusive with the text input; each voice state
// maps to one of four display modes for the middle slot of the bar.
const isRecording = computed(() => voice.state.value === 'recording')
const isTranscribing = computed(() => voice.state.value === 'transcribing')
const isRequestingPerm = computed(() => voice.state.value === 'requesting-permission')
const voiceActive = computed(() => isRecording.value || isTranscribing.value || isRequestingPerm.value)
/** The voice state while `voiceActive` (the middle slot shows it instead of the input). */
const voiceState = computed(() => isRecording.value ? 'recording' : isTranscribing.value ? 'transcribing' : 'requesting-permission')

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

// Other people's sessions: only who it is for, their prompt and the
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
    case 'job': return 'i-lucide-layers'
    case 'error': return 'i-lucide-alert-circle'
    case 'done': return 'i-lucide-check-circle'
    // Fallback: pulsing-circle for no phase or any unknown active one. The
    // brand reserves the seal for the brand mark itself; here we
    // just need a "still working" glyph.
    case undefined:
    default: return 'i-lucide-loader'
  }
})

// Bottom bar animates whenever there's an active session for the
// caller. The bottom bar and the selection popup both point at
// the same session: having both surfaces animate in sync reinforces
// "AI is working" rather than competing for attention.
const isActive = computed(() => !!props.ai.mySession.value)

// True when the response panel is showing in its expanded card form
// (not the small "last response" pill). Drives the wrapper's
// `.has-response` class so CSS can collapse the gap between the panel
// and the bar shell and round only the touching corners. Mirrored from
// the panel's `update:expanded` emit so it matches what the panel shows,
// including hover-pause.
const hasResponseExpanded = ref(false)
function onPanelExpandedChange(v: boolean) {
  hasResponseExpanded.value = v
}

const { bottomOffset } = usePromptBarOffset()
</script>

<template>
  <!-- Floating AI bar above the bottom edge of the editor + preview.
       Shu (the brand red) means AI presence, and the prompt bar is the
       AI's primary entry point, so its ring is the brand's most
       prominent shu surface. -->
  <div
    class="ai-prompt-bar pointer-events-none absolute inset-x-0 z-20 flex flex-col items-center px-4"
    :class="{ 'is-focused': focused, 'is-active': isActive, 'has-response': hasResponseExpanded }"
    :style="{ bottom: bottomOffset }"
    data-testid="ai-prompt-bar"
    :data-active="isActive ? 'true' : 'false'"
    :data-last-outcome="props.ai.lastOutcome?.value?.phase ?? ''"
    :data-last-outcome-message="props.ai.lastOutcome?.value?.message ?? ''"
  >
    <!-- Ephemeral response panel: driven by `useAI`'s latched
         `lastResponse`. When expanded, it visually merges into the
         prompt bar shell below (single floating section). When
         collapsed it floats as a separate pill above the bar. -->
    <!-- Allow / Deny for a cross-document, knowledge or web action the
         AI wants to take after reading other people's text. Private to
         the initiator (session channel), never broadcast. -->
    <!-- Progress of my delegated job (translation, tone change over many
         sections), private to me; it keeps running after the session. -->
    <AIJobPanel
      v-if="props.docId"
      :doc-id="props.docId"
      :my-job-ids="props.ai.myJobIds?.value ?? []"
    />
    <AIConfirmPanel
      :request="props.ai.pendingConfirmation.value"
      :busy="props.ai.answeringConfirmation.value"
      @allow="props.ai.answerConfirmation(true)"
      @deny="(note?: string) => props.ai.answerConfirmation(false, note)"
    />
    <AIResponsePanel
      :response="props.ai.lastResponse.value"
      class="ai-prompt-bar__response"
      @update:expanded="onPanelExpandedChange"
    />
    <div
      class="ai-prompt-bar__shell pointer-events-auto w-full max-w-3xl flex items-center gap-0 rounded-full pl-5 pr-0 py-0 backdrop-blur-md transition-all"
    >
      <!-- Leading live status icon. The prompt bar looks the same in
           voice and text states; only the middle slot changes. -->
      <!-- Idle state: the brand seal. The design system bans AI-sparkle
           iconography ("the seal is the AI's mark"). Active states keep
           their phase-specific lucide icons in shu. -->
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
           `v-if`/`v-else-if` chain so only one mounts at a time, keeps
           a11y simple and prevents the input from absorbing keystrokes
           while the user is mid-recording. -->
      <!-- `py-2` (not `py-3` like the text input) compensates for the
           32px waveform canvas: 8 + 32 + 8 = 48 px matches the text
           input's 12 + 24 (line-height) + 12 exactly, so the pill
           doesn't grow vertically when the user toggles the mic. -->
      <AiPromptVoiceStatus
        v-if="voiceActive"
        :state="voiceState"
        :levels="voice.levels.value"
        :duration-sec="voice.durationSec.value"
        :max-duration-sec="voice.maxDurationSec"
      />
      <!-- AI prompt input wears the editorial italic-serif voice (Fraunces
           italic): the brand reserves italic-serif for "the AI is
           speaking", and this extends it to the user's side of the
           conversation. Placeholder and typed text inherit the family. -->
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

      <!-- Other-sessions indicator: kept compact so the bar doesn't
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
           capture). Same physical location keeps the bar visually stable,
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
      <UButton
        v-else-if="!isActive && transcriptionLocked && !chatMissing"
        color="neutral"
        variant="ghost"
        icon="i-lucide-mic"
        :aria-label="t('ai.locked.aiVoice')"
        :title="t('ai.locked.aiVoice')"
        data-testid="ai-prompt-bar-mic-locked"
        class="ai-prompt-bar__secondary opacity-50"
        @click="explainLocked('aiVoice')"
      />

      <!-- The AI suggests instead of editing (fixed on where the document requires suggestions). -->
      <UTooltip
        v-if="!isActive && loggedIn && !chatMissing && !isRecording && !isTranscribing"
        :text="suggestForced ? t('suggestions.ai.forced') : (aiSuggest ? t('suggestions.ai.on') : t('suggestions.ai.off'))"
      >
        <UButton
          icon="i-lucide-file-diff"
          color="neutral"
          :variant="aiSuggest || suggestForced ? 'soft' : 'ghost'"
          size="sm"
          :aria-label="t('suggestions.ai.toggle')"
          :aria-pressed="aiSuggest || suggestForced"
          :aria-disabled="suggestForced"
          data-testid="ai-prompt-bar-suggest"
          @click="suggestForced || (aiSuggest = !aiSuggest)"
        />
      </UTooltip>

      <!-- Primary slot: send. Stays primary across idle + recording so the
           bar doesn't shift when the user starts speaking. Clicking while
           recording stops the mic, which triggers transcription +
           auto-submit. During transcription the button shows a spinner
           and is disabled; cancel (×) in the secondary slot is the only
           escape. -->
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
        Send button. When credits are exhausted we do NOT disable it,
        the click routes to /pricing instead, keeping the escape
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
        :aria-label="creditsExhausted ? exhaustedPlaceholder : t('ai.send')"
        :title="creditsExhausted ? exhaustedPlaceholder : undefined"
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
 * gradient/shadow stack: Tailwind's arbitrary-value escapes for
 * stacked shadows with color-mix become unreadable.
 */
.ai-prompt-bar__shell {
  /* `--ui-bg-muted` keeps the bar in the same warm chrome tone as the
     toolbar, status bar and right sidebar. Ring and glow are
     full-strength shu. */
  background: color-mix(in srgb, var(--ui-bg-muted) 88%, transparent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--color-shu-500) 70%, transparent),
    0 14px 36px -12px color-mix(in srgb, var(--color-shu-500) 32%, transparent),
    0 8px 24px -8px rgb(20 17 13 / 0.15);
  /* A finite radius instead of Tailwind's `rounded-full` (which emits
     `calc(infinity * 1px)`): a 1.5rem to 0 corner transition
     interpolates, while one from `infinity` snaps at the end. 1.5rem is
     half the ~48px bar height, so it still looks like a pill. Scoped
     specificity beats the inline utility class. */
  border-radius: 1.5rem;
  /* A longer curve for `border-radius` only: the morph between the
     standalone pill and the merged shape (flat top, joined to the
     response panel) needs more time than the 150ms default. The entry
     comes last so it wins for that property. */
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

html.dark .ai-prompt-bar.is-focused .ai-prompt-bar__shell {
  box-shadow:
    0 0 0 1.5px color-mix(in srgb, var(--color-shu-400) 90%, transparent),
    0 18px 44px -12px color-mix(in srgb, var(--color-shu-400) 50%, transparent),
    0 8px 24px -8px rgb(0 0 0 / 0.45);
}

/*
 * Active session: a pulsing shu glow. `--mk-pulse` eases 0 to 1 and
 * back, breathing the ring thickness and the glow's blur + opacity.
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

/* Single shu glow that fades in and out: shu means AI presence, nothing
   else, so the active state does not cycle hues. */
@keyframes mk-pulse {
  0%, 100% { --mk-pulse: 0; }
  50%      { --mk-pulse: 1; }
}

.ai-prompt-bar.is-active .ai-prompt-bar__shell {
  animation: mk-pulse 2.4s ease-in-out infinite;
  --_p: var(--mk-pulse);

  box-shadow:
    /* Border ring: stays at the brand shu, thickness pulses 1.5 → 2.5 px */
    0 0 0 calc(1.5px + var(--_p) * 1px) color-mix(in srgb, var(--color-shu-500) calc(60% + var(--_p) * 25%), transparent),
    /* Outer glow: blur and opacity breathe; hue is locked to shu */
    0 calc(16px + var(--_p) * 12px) calc(40px + var(--_p) * 28px) -12px color-mix(in srgb, var(--color-shu-500) calc(35% + var(--_p) * 30%), transparent),
    /* Static warm-tinted drop shadow underneath */
    0 8px 24px -8px rgb(20 17 13 / 0.18);
}

html.dark .ai-prompt-bar.is-active .ai-prompt-bar__shell {
  box-shadow:
    0 0 0 calc(1.5px + var(--_p) * 1px) color-mix(in srgb, var(--color-shu-400) calc(60% + var(--_p) * 25%), transparent),
    0 calc(16px + var(--_p) * 12px) calc(40px + var(--_p) * 28px) -12px color-mix(in srgb, var(--color-shu-400) calc(35% + var(--_p) * 30%), transparent),
    0 8px 24px -8px rgb(0 0 0 / 0.45);
}

/* Reduced motion: drop the animation but keep the active state distinct
 * with a static, stronger shu glow. */
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
 * Action button: a circle that fills the input row's height so it sits
 * edge-to-edge in the pill (the shell has `py-0` + `pr-0`; the input is
 * `py-3` + ~24px line height = 48px, so the button is 48px square).
 * UButton's own size/rounded utilities have the same specificity as any
 * class put on the element, hence `!important`. `:deep` is required
 * because UButton renders the <button> as a child-component root, which
 * scoped attribute selectors miss.
 */
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
  width: 1.25rem !important;       /* 20 px, proportional to the 48 px button */
  height: 1.25rem !important;
}

/*
 * Secondary button: mic (idle), cancel (×). Smaller + ghost so the
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
 * Response panel and shell merge: when the response panel is expanded
 * (not the collapsed pill) it reads as ONE floating section with the
 * shell below it: shared shu ring, shared glow, no gap. The pill keeps
 * a small gap so it floats as a separate chip.
 *
 * In `.has-response` the wrapper's gap is dropped, the panel loses its
 * bottom radius and the shell loses its top radius.
 */
/*
 * Merged mode geometry. The shell paints its shu ring as an OUTSET 1px
 * box-shadow, outside its layout box. The panel therefore has no
 * `border` (it would sit inside the box) and gets the SAME outset 1px
 * shadow ring, so both surfaces paint to the same outer extent and the
 * seam is pixel-perfect. All four shell corners are fixed at 1.5rem so
 * the merged section is one consistently rounded rectangle.
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
    /* Outset 1px shu ring, same recipe as the shell's static ring */
    0 0 0 1px color-mix(in srgb, var(--color-shu-500) 70%, transparent),
    /* Soft top glow: pulled UP so it doesn't bleed into the seam */
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

/* Merged mode: the shell flattens its TOP corners (seam with the panel)
   and pins its BOTTOM corners to 1.5rem.
 *
 * A fixed bottom value is needed because CSS clamps each corner radius
 * against the shared edge length. In the standalone pill the left edge
 * is split between top-left and bottom-left (about half the height
 * each). With the top corners at 0, `rounded-full`'s bottom-left would
 * get the whole edge and sweep up the left side, and the right one
 * would clip the send button. 1.5rem matches what the pill clamped to
 * at this height, so the merged section is panel-top 1.5rem,
 * bar-bottom 1.5rem, with a straight seam. */
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

/* Pill mode (collapsed): floats as a distinct chip. The wrapper gap is
   dropped for the merged case, so restore it via margin here. */
.ai-prompt-bar:not(.has-response) :deep(.ai-response-pill) {
  margin-bottom: 0.5rem;
}
</style>
