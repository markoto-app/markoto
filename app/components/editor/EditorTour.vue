<script setup lang="ts">
import {
  anchorSelector, DESKTOP_TOUR_STEPS, editorTourAutoStart, editorTourDone, markEditorTourDone,
  MOBILE_TOUR_STEPS, tourTypingWait, type EditorTourStep
} from '~/utils/editor/editorTour'

/**
 * Short first-run tour of the editor: one popover at a time, anchored to
 * the real control it talks about (Nuxt UI popover `reference`), with
 * Skip and Next / Done. Shown once on the first editor visit: per account
 * when signed in (`editorTourDone` of the account status, set through
 * POST /api/user/editor-tour; sign-out clears localStorage), per browser
 * otherwise (localStorage, `utils/editorTour.ts`). Help → "Take the tour"
 * (or the phone menu) starts it again through `start()`.
 *
 * It never fights other dialogs: while any modal, sheet or alert dialog
 * is open (onboarding gate, password prompt, share dialog…) the popover
 * hides and waits. Steps whose control isn't on screen (no Theme button
 * for a viewer, no AI bar) are left out.
 */
const props = defineProps<{
  /** The editor is mounted, writable and not behind a password prompt. */
  ready: boolean
  isMobile: boolean
}>()

const { t } = useI18n()
const { loggedIn } = useUserSession()
const { status: accountStatus, pending: accountPending, refresh: refreshAccountStatus } = useAccountStatus()

const steps = ref<EditorTourStep[]>([])
const index = ref(0)
const running = ref(false)
const blocked = ref(false)
const reference = ref<HTMLElement | null>(null)

// localStorage isn't reactive: mirror the flag so `autoStart` follows `finish()`.
const localDone = ref(editorTourDone(globalThis.localStorage ?? null))
const autoStart = computed(() => editorTourAutoStart({
  localDone: localDone.value,
  loggedIn: loggedIn.value,
  accountPending: accountPending.value,
  accountDone: accountStatus.value?.editorTourDone ?? null
}))

const current = computed(() => steps.value[index.value] ?? null)
const isLast = computed(() => index.value >= steps.value.length - 1)

function findAnchor(step: EditorTourStep): HTMLElement | null {
  const label = step.anchor.kind === 'testid' ? '' : t(step.anchor.labelKey)
  const el = document.querySelector(anchorSelector(step.anchor, label))
  // offsetParent is null for display:none (e.g. the desktop menu bar on a phone).
  return el instanceof HTMLElement && el.offsetParent !== null ? el : null
}

function show(): void {
  const step = current.value
  reference.value = step ? findAnchor(step) : null
}

/** Any other dialog-like surface open right now? */
function otherDialogOpen(): boolean {
  return document.querySelector(
    '[role="dialog"][data-state="open"]:not(:has([data-editor-tour])), [role="alertdialog"], .mk-sheet-host'
  ) !== null
}

let poll: ReturnType<typeof setInterval> | undefined
function watchDialogs(): void {
  clearInterval(poll)
  blocked.value = otherDialogOpen()
  poll = setInterval(() => {
    blocked.value = otherDialogOpen()
  }, 400)
}

function start(): void {
  const all = props.isMobile ? MOBILE_TOUR_STEPS : DESKTOP_TOUR_STEPS
  steps.value = all.filter(s => findAnchor(s) !== null)
  if (steps.value.length === 0) return
  index.value = 0
  running.value = true
  watchDialogs()
  show()
}

function finish(): void {
  running.value = false
  reference.value = null
  clearInterval(poll)
  markEditorTourDone(globalThis.localStorage ?? null)
  localDone.value = true
  if (loggedIn.value && accountStatus.value?.editorTourDone !== true) void rememberOnAccount()
}

/** Best effort: if it fails, this browser's flag still holds until sign-out. */
async function rememberOnAccount(): Promise<void> {
  try {
    await apiFetch('/api/user/editor-tour', { method: 'post' })
    await refreshAccountStatus()
  } catch {
    // Offline or signed out meanwhile.
  }
}

function next(): void {
  if (isLast.value) {
    finish()
    return
  }
  index.value++
  show()
  // A control that went away since the tour started: skip its step.
  if (!reference.value) next()
}

// When the user last pressed a key: the tour never opens on someone who is typing.
let lastKeyAt = 0
useEventListener(globalThis, 'keydown', (e: KeyboardEvent) => {
  lastKeyAt = Date.now()
  if (running.value && !blocked.value && e.key === 'Escape') finish()
})

// First visit: start shortly after the editor is ready, so the page has
// settled (and an onboarding / password dialog had its chance to open),
// and wait while the user is typing (someone who opens a document and
// starts a prompt or a sentence right away would lose keystrokes).
const AUTO_START_DELAY_MS = 1500
let autoTimer: ReturnType<typeof setTimeout> | undefined
function scheduleAutoStart(delay: number): void {
  clearTimeout(autoTimer)
  autoTimer = setTimeout(() => {
    if (!props.ready || running.value || autoStart.value !== 'show') return
    const wait = tourTypingWait(Date.now(), lastKeyAt)
    if (wait > 0) {
      scheduleAutoStart(wait)
      return
    }
    start()
  }, delay)
}
// Signed in, the account status may still be loading: `autoStart` is `wait`
// until it is in, then the watcher runs again.
watch([() => props.ready, autoStart], ([ready, decision]) => {
  clearTimeout(autoTimer)
  if (!ready || running.value || decision !== 'show') return
  scheduleAutoStart(AUTO_START_DELAY_MS)
}, { immediate: true })

// The popover never moves focus, opening or closing: whatever the user is
// in (the prompt bar, the editor) keeps the keyboard.
function keepFocus(e: Event): void {
  e.preventDefault()
}

onBeforeUnmount(() => {
  clearTimeout(autoTimer)
  clearInterval(poll)
})

defineExpose({ start })
</script>

<template>
  <UPopover
    v-if="running && current"
    :open="!blocked && reference !== null"
    :reference="reference ?? undefined"
    :dismissible="false"
    :modal="false"
    :content="{ side: current.side, sideOffset: 10, collisionPadding: 12, onOpenAutoFocus: keepFocus, onCloseAutoFocus: keepFocus }"
    arrow
  >
    <template #content>
      <div
        class="w-72 max-w-[calc(100vw-32px)] p-4"
        data-editor-tour
        data-testid="editor-tour"
      >
        <p class="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
          {{ t('editorTour.stepOf', { n: index + 1, total: steps.length }) }}
        </p>
        <h2 class="mt-1.5 font-serif text-lg font-normal tracking-tight text-default">
          {{ t(current.titleKey) }}
        </h2>
        <p class="mt-1.5 text-[13.5px] leading-relaxed text-default">
          {{ t(current.bodyKey) }}
        </p>
        <div class="mt-4 flex items-center justify-between gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            data-testid="editor-tour-skip"
            @click="finish"
          >
            {{ t('editorTour.skip') }}
          </UButton>
          <UButton
            color="neutral"
            size="sm"
            :trailing-icon="isLast ? undefined : 'i-lucide-arrow-right'"
            data-testid="editor-tour-next"
            @click="next"
          >
            {{ isLast ? t('editorTour.done') : t('editorTour.next') }}
          </UButton>
        </div>
      </div>
    </template>
  </UPopover>
</template>
