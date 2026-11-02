<script setup lang="ts">
import type { EditorView } from '@codemirror/view'

// Floating "Comment" pill that appears just below the user's selection
// in the editor. Click → emits `trigger`, which the parent forwards to
// the same create-comment handler that the toolbar / menu use. The
// popup itself never touches the Y.js doc — single source of truth
// stays in CommentsPanel's `startDraft()`.
//
// Lifecycle mirrors the (deleted) AISelectionPopup: a `selectionchange`
// listener on the document watches the editor's selection, shows the
// pill on non-empty selections, hides on collapse / blur / click-out.
// Click-outside is suppressed when the click landed on the pill itself
// (handled by `@mousedown.stop` on the root).

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

// The selection a comment was just started on. Once the pill has been
// used, the same selection doesn't bring it back (it lingered next to
// the new thread after posting, because focus returns to the editor with
// the passage still selected). Any other selection clears it.
let usedRange: { from: number, to: number } | null = null

onClickOutside(popupEl, () => hide())

function reposition(view: EditorView) {
  const sel = view.state.selection.main
  if (sel.empty) return
  // Position at the END of the selection so the pill doesn't cover the
  // start (where the user's eye usually is). Coords are viewport-relative;
  // `position: fixed` consumes them directly.
  const coords = view.coordsAtPos(sel.to)
  if (!coords) return
  // Pill measurements: hidden = height 0, so we measure when visible.
  // Default to a conservative estimate when not yet rendered (first
  // appearance). 120×32 covers the "Add comment" pill at most locales.
  const pill = popupEl.value
  const pillW = pill?.offsetWidth || 120
  const pillH = pill?.offsetHeight || 32
  // Use `visualViewport` when present so the pill sits inside the
  // mobile keyboard's available area, not behind it. Falls back to
  // `window.innerHeight` on platforms without VV.
  const viewportH = window.visualViewport?.height ?? window.innerHeight
  const viewportW = window.innerWidth
  // Horizontal: prefer just below the selection-end; clamp to 8px
  // margins so nothing overflows on narrow screens.
  let x = coords.left - 4
  x = Math.min(x, viewportW - pillW - 8)
  x = Math.max(8, x)
  popupX.value = x
  // Vertical: prefer below the selection. If that puts the pill in or
  // below the keyboard's intrusion zone, flip ABOVE the selection
  // (`coords.top - pillH - 6`). The flip keeps the comment affordance
  // discoverable on mobile when typing at the bottom of the doc.
  const below = coords.bottom + 6
  if (below + pillH <= viewportH - 8) {
    popupY.value = below
  } else {
    popupY.value = Math.max(8, coords.top - pillH - 6)
  }
}

// `selectionchange` fires on the document while the editor view's
// `blur` fires on the CM6 contentDOM. Both are tied via useEventListener
// to refs that re-bind when the view changes — no manual attach/remove
// dance.
const blurTarget = computed(() => props.view?.contentDOM ?? null)

function onSelectionChange() {
  const view = props.view
  if (!view) return
  if (props.disabled) {
    if (visible.value) hide()
    return
  }
  // Only for the selection the user is working with: when the editor
  // isn't focused (typing in the AI prompt bar, a remote or AI edit
  // moving the DOM selection) the pill stays hidden — it used to pop up
  // again at a stale spot after the AI rewrote the selected passage.
  if (!view.hasFocus) {
    if (visible.value) hide()
    return
  }
  const sel = view.state.selection.main
  if (sel.empty) {
    usedRange = null
    if (visible.value) hide()
    return
  }
  if (usedRange && usedRange.from === sel.from && usedRange.to === sel.to) {
    if (visible.value) hide()
    return
  }
  usedRange = null
  const text = view.state.sliceDoc(sel.from, sel.to).trim()
  if (!text) {
    if (visible.value) hide()
    return
  }
  visible.value = true
  reposition(view)
}

// Hide when focus leaves the editor (clicking elsewhere implicitly
// collapses or moves the selection most of the time, but blur is a
// belt-and-braces signal).
function onBlur() {
  setTimeout(() => {
    if (document.activeElement?.closest('.comment-selection-popup')) return
    hide()
  }, 120)
}

useEventListener(document, 'selectionchange', onSelectionChange)
useEventListener(blurTarget, 'blur', onBlur)

// If `disabled` flips on mid-selection, hide immediately so the pill
// doesn't survive a permission downgrade.
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
 * Selection-comment trigger pill. Same visual family as the AI prompt
 * bar — frosted bone backdrop, hairline shu ring + soft shu glow. The
 * brand reserves shu for AI presence, but a comment carries a strong
 * loop affordance to summon markoto via `@markoto`, so the seal red
 * is the right anchor here too. Earlier this popup wore amber, which
 * read as a separate semantic and broke the editor's color discipline.
 */
.comment-selection-popup__pill {
  background: color-mix(in srgb, var(--ui-bg-muted) 88%, transparent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--color-shu-500) 40%, transparent),
    0 8px 24px -10px color-mix(in srgb, var(--color-shu-500) 25%, transparent),
    0 4px 12px -4px rgb(20 17 13 / 0.12);
}

:global(.dark) .comment-selection-popup__pill {
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
