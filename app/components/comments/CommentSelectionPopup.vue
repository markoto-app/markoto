<script setup lang="ts">
import type { EditorView } from '@codemirror/view'

// Floating "Comment" pill just below the editor selection. Click emits
// `trigger`, which the parent forwards to the create-comment handler shared
// with the toolbar and menu; the popup never touches the Y.js doc.
//
// A `selectionchange` listener shows the pill on non-empty selections and
// hides it on collapse / blur / click-out (clicks on the pill are exempted
// via `@mousedown.stop` on the root).

const props = defineProps<{
  view: EditorView | null
  /** Hide entirely when the doc is read-only / password-gated. */
  disabled: boolean
}>()

const emit = defineEmits<{
  trigger: []
}>()

const { t } = useI18n()

const visible = ref(false)
const popupX = ref(0)
const popupY = ref(0)
const popupEl = ref<HTMLElement | null>(null)

function hide() {
  visible.value = false
}

// The selection a comment was just started on; it doesn't bring the pill back
// (focus returns to the editor with the passage still selected). Any other
// selection clears it.
let usedRange: { from: number, to: number } | null = null

onClickOutside(popupEl, () => hide())

function reposition(view: EditorView) {
  const sel = view.state.selection.main
  if (sel.empty) return
  // Anchor at the END of the selection so the pill doesn't cover the start
  // where the eye is. Coords are viewport-relative (`position: fixed`).
  const coords = view.coordsAtPos(sel.to)
  if (!coords) return
  // The hidden pill has height 0, so measure when visible; fall back to an
  // estimate (120×32) before first render.
  const pill = popupEl.value
  const pillW = pill?.offsetWidth || 120
  const pillH = pill?.offsetHeight || 32
  // `visualViewport` keeps the pill inside the mobile keyboard's free area.
  const viewportH = window.visualViewport?.height ?? window.innerHeight
  const viewportW = window.innerWidth
  // Horizontal: clamp to 8px margins on narrow screens.
  let x = coords.left - 4
  x = Math.min(x, viewportW - pillW - 8)
  x = Math.max(8, x)
  popupX.value = x
  // Vertical: below the selection; if that lands in the keyboard's zone, flip
  // above (`coords.top - pillH - 6`) so it stays reachable on mobile.
  const below = coords.bottom + 6
  if (below + pillH <= viewportH - 8) {
    popupY.value = below
  } else {
    popupY.value = Math.max(8, coords.top - pillH - 6)
  }
}

// `selectionchange` fires on the document, `blur` on the CM6 contentDOM; both
// bind via useEventListener to refs that follow view changes.
const blurTarget = computed(() => props.view?.contentDOM ?? null)

/**
 * Whether the pill belongs to the current selection. Only for the selection
 * the user is working with: none while the editor is unfocused (AI prompt bar
 * typing, remote or AI edits moving the DOM selection), and none again for
 * the selection a comment was just started from (`usedRange`, forgotten once
 * that selection is gone).
 */
function selectionWantsPill(view: EditorView): boolean {
  if (props.disabled || !view.hasFocus) return false
  const sel = view.state.selection.main
  if (sel.empty) {
    usedRange = null
    return false
  }
  if (usedRange && usedRange.from === sel.from && usedRange.to === sel.to) return false
  usedRange = null
  return view.state.sliceDoc(sel.from, sel.to).trim() !== ''
}

function onSelectionChange() {
  const view = props.view
  if (!view) return
  if (!selectionWantsPill(view)) {
    if (visible.value) hide()
    return
  }
  visible.value = true
  reposition(view)
}

// Hide on blur too: a click elsewhere usually collapses the selection, but
// blur is a belt-and-braces signal.
function onBlur() {
  setTimeout(() => {
    if (document.activeElement?.closest('.comment-selection-popup')) return
    hide()
  }, 120)
}

useEventListener(document, 'selectionchange', onSelectionChange)
useEventListener(blurTarget, 'blur', onBlur)

// Hide immediately if `disabled` flips mid-selection (permission downgrade).
watch(() => props.disabled, (d) => {
  if (d) hide()
})

function onClick() {
  const sel = props.view?.state.selection.main
  usedRange = sel ? { from: sel.from, to: sel.to } : null
  emit('trigger')
  hide()
}
</script>

<template>
  <div
    v-if="visible && !disabled"
    ref="popupEl"
    class="comment-selection-popup fixed z-50"
    :style="{ left: popupX + 'px', top: popupY + 'px' }"
    @mousedown.stop
    @click.stop
  >
    <button
      type="button"
      class="comment-selection-popup__pill inline-flex items-center gap-1.5 rounded-full pl-2.5 pr-3 py-1.5 text-xs font-medium backdrop-blur-md transition-all"
      data-testid="comment-selection-popup-trigger"
      @click="onClick"
    >
      <UIcon
        name="i-lucide-message-circle"
        class="size-3.5 text-shu-500 dark:text-shu-400 shrink-0"
      />
      <span>{{ t('comments.addLabel') }}</span>
    </button>
  </div>
</template>

<style scoped>
/*
 * Same visual family as the AI prompt bar: frosted bone backdrop, hairline shu
 * ring and soft glow. Shu is the AI mark, and a comment is the way to summon
 * markoto via `@markoto`.
 */
.comment-selection-popup__pill {
  background: color-mix(in srgb, var(--ui-bg-muted) 88%, transparent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--color-shu-500) 40%, transparent),
    0 8px 24px -10px color-mix(in srgb, var(--color-shu-500) 25%, transparent),
    0 4px 12px -4px rgb(20 17 13 / 0.12);
}

html.dark .comment-selection-popup__pill {
  background: color-mix(in srgb, var(--ui-bg-muted) 78%, transparent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--color-shu-400) 50%, transparent),
    0 8px 24px -10px color-mix(in srgb, var(--color-shu-400) 32%, transparent),
    0 4px 12px -4px rgb(0 0 0 / 0.45);
}

.comment-selection-popup__pill:hover {
  box-shadow:
    0 0 0 1.5px color-mix(in srgb, var(--color-shu-500) 55%, transparent),
    0 12px 32px -10px color-mix(in srgb, var(--color-shu-500) 35%, transparent),
    0 4px 12px -4px rgb(20 17 13 / 0.16);
}
</style>
