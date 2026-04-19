<script setup lang="ts">
import { EditorView } from '@codemirror/view'
import * as Y from 'yjs'
import type { Text as YText } from 'yjs'

const props = defineProps<{
  view: EditorView | null
  ytext: YText
  onRewrite: (params: {
    selectionText: string
    selectionFrom: number
    selectionTo: number
    relFrom: any
    relTo: any
    instruction: string
  }) => Promise<boolean>
}>()

const { t } = useI18n()
const { loggedIn } = useUserSession()
const toast = useToast()

// Popup state
const visible = ref(false)     // is the popup rendered
const expanded = ref(false)    // is the text input shown (vs the sparkles pill)
const submitting = ref(false)
const focused = ref(false)
const instruction = ref('')
const popupX = ref(0)
const popupY = ref(0)

// Cached selection at the moment we show the popup — don't rely on `view`
// at submit time because the selection may have changed.
interface CapturedSelection {
  text: string
  from: number
  to: number
  relFrom: any
  relTo: any
}
const captured = ref<CapturedSelection | null>(null)

const inputEl = ref<HTMLInputElement | null>(null)
const popupEl = ref<HTMLElement | null>(null)

// Dismiss on any click outside the popup — including clicks inside the editor,
// which is the natural way users collapse a selection.
onClickOutside(popupEl, () => hide())

function hide() {
  visible.value = false
  expanded.value = false
  instruction.value = ''
  captured.value = null
  focused.value = false
}

function reposition(view: EditorView) {
  const sel = view.state.selection.main
  if (sel.empty) return
  const coords = view.coordsAtPos(sel.to)
  if (!coords) return
  popupX.value = Math.max(8, coords.left - 8)
  popupY.value = coords.bottom + 6
}

function captureSelection(view: EditorView) {
  const sel = view.state.selection.main
  if (sel.empty) return null
  const text = view.state.sliceDoc(sel.from, sel.to).trim()
  if (!text) return null

  let relFrom: any = null
  let relTo: any = null
  try {
    relFrom = Y.createRelativePositionFromTypeIndex(props.ytext, sel.from)
    relTo = Y.createRelativePositionFromTypeIndex(props.ytext, sel.to)
  } catch { /* fall back to raw indices on the server */ }

  return {
    text,
    from: sel.from,
    to: sel.to,
    relFrom: relFrom ? JSON.parse(JSON.stringify(relFrom)) : null,
    relTo: relTo ? JSON.parse(JSON.stringify(relTo)) : null
  } as CapturedSelection
}

let removeSelectionListener: (() => void) | null = null

function attachListener(view: EditorView) {
  const handler = () => {
    if (expanded.value) return
    const sel = view.state.selection.main
    if (sel.empty || !loggedIn.value) {
      if (visible.value && !expanded.value) hide()
      return
    }
    const text = view.state.sliceDoc(sel.from, sel.to).trim()
    if (!text) {
      if (visible.value && !expanded.value) hide()
      return
    }
    visible.value = true
    expanded.value = false
    reposition(view)
  }

  const contentEl = view.contentDOM
  const onSelChange = () => handler()
  const onBlur = () => {
    setTimeout(() => {
      if (document.activeElement && document.activeElement.closest('.ai-selection-popup')) return
      if (!expanded.value) hide()
    }, 120)
  }

  document.addEventListener('selectionchange', onSelChange)
  contentEl.addEventListener('blur', onBlur)

  removeSelectionListener = () => {
    document.removeEventListener('selectionchange', onSelChange)
    contentEl.removeEventListener('blur', onBlur)
  }
}

watch(() => props.view, (view) => {
  if (removeSelectionListener) {
    removeSelectionListener()
    removeSelectionListener = null
  }
  if (view) attachListener(view)
}, { immediate: true })

onUnmounted(() => {
  if (removeSelectionListener) removeSelectionListener()
})

async function onActivate() {
  if (!props.view) return
  const snap = captureSelection(props.view)
  if (!snap) { hide(); return }
  captured.value = snap
  expanded.value = true
  await nextTick()
  inputEl.value?.focus()
}

async function onSubmit() {
  if (!captured.value || submitting.value) return
  const text = instruction.value.trim()
  if (!text) return

  submitting.value = true
  try {
    const ok = await props.onRewrite({
      selectionText: captured.value.text,
      selectionFrom: captured.value.from,
      selectionTo: captured.value.to,
      relFrom: captured.value.relFrom,
      relTo: captured.value.relTo,
      instruction: text
    })
    if (ok) {
      hide()
    } else {
      toast.add({
        title: t('ai.failed'),
        description: '',
        icon: 'i-lucide-alert-circle',
        color: 'error'
      })
    }
  } finally {
    submitting.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    hide()
  }
}
</script>

<template>
  <div
    v-if="visible && loggedIn"
    ref="popupEl"
    class="ai-selection-popup fixed z-50"
    :style="{ left: popupX + 'px', top: popupY + 'px' }"
    :class="{ 'is-focused': focused, 'is-active': submitting }"
    @mousedown.stop
    @click.stop
  >
    <!-- Collapsed: small blue pill with sparkle. Same visual family as
         the floating bottom bar — the "younger brother". -->
    <button
      v-if="!expanded"
      type="button"
      class="ai-selection-popup__pill inline-flex items-center gap-2 rounded-full pl-3 pr-4 py-1.5 text-sm font-medium backdrop-blur-md transition-all"
      @click="onActivate"
    >
      <UIcon name="i-lucide-sparkles" class="size-4 text-blue-500 shrink-0" />
      <span>{{ t('ai.rewriteButton') }}</span>
    </button>

    <!-- Expanded: pill input matching the bottom AI bar at smaller scale. -->
    <div
      v-else
      class="ai-selection-popup__shell flex items-center gap-0 rounded-full pl-4 pr-0 py-0 backdrop-blur-md transition-all"
    >
      <UIcon
        name="i-lucide-sparkles"
        class="size-4 text-blue-500 shrink-0 mr-2"
        :class="{ 'animate-pulse': submitting }"
      />
      <input
        ref="inputEl"
        v-model="instruction"
        type="text"
        :placeholder="t('ai.rewritePlaceholder')"
        class="w-72 bg-transparent outline-none text-sm text-default placeholder:text-muted py-2 pr-0"
        :disabled="submitting"
        @focus="focused = true"
        @blur="focused = false"
        @keydown.enter="onSubmit"
        @keydown="onKeydown"
      >
      <UButton
        color="info"
        icon="i-lucide-send"
        :loading="submitting"
        :disabled="!instruction.trim()"
        :aria-label="t('ai.send')"
        class="ai-selection-popup__action"
        @click="onSubmit"
      />
    </div>
  </div>
</template>

<style scoped>
/*
 * AI selection popup — the "younger brother" of the floating AI prompt
 * bar. Same color story (blue accent, frosted backdrop, pill shape),
 * proportionally smaller. While the rewrite is in flight the ring
 * cycles through the rainbow and pulses, mirroring the bottom bar's
 * active treatment.
 *
 * The animation is entirely driven by the local `submitting` ref —
 * the rewrite endpoint is a one-shot REST call (no Y.js awareness
 * write), so the popup's animation does not bleed over into the
 * floating prompt bar's `isActive` state. Each surface stays in
 * sync with its own work.
 *
 * `@property` registrations are global; re-declaring the same name
 * in two `<style scoped>` blocks is a no-op (CSS dedupes), so this
 * works alongside `AIPromptBar.vue` without conflict. `@keyframes`
 * names get a per-component suffix from Vue's scoped-CSS rewrite, so
 * each component animates on its own timeline.
 */

.ai-selection-popup__shell,
.ai-selection-popup__pill {
  background: color-mix(in srgb, var(--ui-bg) 88%, transparent);
  box-shadow:
    0 0 0 1.5px color-mix(in srgb, var(--color-blue-500, #3b82f6) 45%, transparent),
    0 12px 32px -10px color-mix(in srgb, var(--color-blue-500, #3b82f6) 30%, transparent),
    0 4px 12px -4px rgb(0 0 0 / 0.15);
}
:global(.dark) .ai-selection-popup__shell,
:global(.dark) .ai-selection-popup__pill {
  background: color-mix(in srgb, var(--ui-bg) 78%, transparent);
  box-shadow:
    0 0 0 1.5px color-mix(in srgb, var(--color-blue-500, #3b82f6) 55%, transparent),
    0 12px 32px -10px color-mix(in srgb, var(--color-blue-500, #3b82f6) 40%, transparent),
    0 4px 12px -4px rgb(0 0 0 / 0.45);
}

.ai-selection-popup__pill:hover {
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--color-blue-500, #3b82f6) 60%, transparent),
    0 16px 40px -10px color-mix(in srgb, var(--color-blue-500, #3b82f6) 40%, transparent),
    0 4px 12px -4px rgb(0 0 0 / 0.18);
}

.ai-selection-popup.is-focused .ai-selection-popup__shell {
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--color-blue-500, #3b82f6) 70%, transparent),
    0 16px 40px -10px color-mix(in srgb, var(--color-blue-500, #3b82f6) 45%, transparent),
    0 4px 12px -4px rgb(0 0 0 / 0.18);
}

/* Active (rewrite in flight) — rainbow + pulse, scaled-down version of
 * the bottom bar's treatment. Same animation tempo so the two surfaces
 * feel like one design system. */
@property --ai-rainbow-hue {
  syntax: '<number>';
  inherits: false;
  initial-value: 0;
}
@property --ai-rainbow-pulse {
  syntax: '<number>';
  inherits: false;
  initial-value: 0;
}

@keyframes ai-rainbow {
  to { --ai-rainbow-hue: 360; }
}
@keyframes ai-pulse {
  0%, 100% { --ai-rainbow-pulse: 0; }
  50%      { --ai-rainbow-pulse: 1; }
}

.ai-selection-popup.is-active .ai-selection-popup__shell {
  animation:
    ai-rainbow 8s linear infinite,
    ai-pulse 2.8s ease-in-out infinite;
  --_h: calc(var(--ai-rainbow-hue) * 1deg);
  --_p: var(--ai-rainbow-pulse);
  box-shadow:
    /* Border ring — pulses 1.5 px → 3 px (smaller than big bar's 2→4) */
    0 0 0 calc(1.5px + var(--_p) * 1.5px) hsl(var(--_h) 90% 60% / 0.85),
    /* Outer glow — proportionally tighter than the bottom bar */
    0 calc(12px + var(--_p) * 10px) calc(32px + var(--_p) * 20px) -10px hsl(var(--_h) 95% 60% / calc(0.4 + var(--_p) * 0.3)),
    0 4px 12px -4px rgb(0 0 0 / 0.2);
}

@media (prefers-reduced-motion: reduce) {
  .ai-selection-popup.is-active .ai-selection-popup__shell {
    animation: none;
    box-shadow:
      0 0 0 2px color-mix(in srgb, var(--color-violet-500, #8b5cf6) 70%, transparent),
      0 16px 40px -10px color-mix(in srgb, var(--color-violet-500, #8b5cf6) 45%, transparent),
      0 4px 12px -4px rgb(0 0 0 / 0.18);
  }
}

/* Round Send button — same circle treatment as the bottom bar, scaled
 * to match the popup's 36 px input row (smaller than the bar's 48 px). */
.ai-selection-popup__shell :deep(.ai-selection-popup__action) {
  width: 2.25rem !important;       /* 36 px */
  height: 2.25rem !important;
  min-height: 2.25rem !important;
  padding: 0 !important;
  border-radius: 9999px !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  flex-shrink: 0 !important;
  gap: 0 !important;
}
.ai-selection-popup__shell :deep(.ai-selection-popup__action .iconify) {
  width: 1rem !important;          /* 16 px */
  height: 1rem !important;
}
</style>
