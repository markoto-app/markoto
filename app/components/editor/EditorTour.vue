<script setup lang="ts">
import {
  anchorSelector, DESKTOP_TOUR_STEPS, editorTourDone, markEditorTourDone, MOBILE_TOUR_STEPS,
  type EditorTourStep
} from '~/utils/editorTour'

/**
 * Short first-run tour of the editor: one popover at a time, anchored to
 * the real control it talks about (Nuxt UI popover `reference`), with
 * Skip and Next / Done. Shown once per browser on the first editor visit
 * (localStorage, `utils/editorTour.ts`); Help → "Take the tour" (or the
 * phone menu) starts it again through `start()`.
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

const steps = ref<EditorTourStep[]>([])
const index = ref(0)
const running = ref(false)
const blocked = ref(false)
const reference = ref<HTMLElement | null>(null)

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

useEventListener(globalThis, 'keydown', (e: KeyboardEvent) => {
  if (running.value && !blocked.value && e.key === 'Escape') finish()
})

// First visit: start shortly after the editor is ready, so the page has
// settled (and an onboarding / password dialog had its chance to open).
let autoTimer: ReturnType<typeof setTimeout> | undefined
watch(() => props.ready, (ready) => {
  clearTimeout(autoTimer)
  if (!ready || running.value) return
  if (editorTourDone(globalThis.localStorage ?? null)) return
  autoTimer = setTimeout(() => {
    if (props.ready && !running.value) start()
  }, 1500)
}, { immediate: true })

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
    :content="{ side: current.side, sideOffset: 10, collisionPadding: 12 }"
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
