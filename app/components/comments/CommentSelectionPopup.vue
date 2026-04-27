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

onClickOutside(popupEl, () => hide())

function reposition(view: EditorView) {
  const sel = view.state.selection.main
  if (sel.empty) return
  // Position at the END of the selection so the pill doesn't cover the
  // start (where the user's eye usually is). Coords are viewport-relative;
  // `position: fixed` consumes them directly.
  const coords = view.coordsAtPos(sel.to)
  if (!coords) return
  popupX.value = Math.max(8, coords.left - 4)
  popupY.value = coords.bottom + 6
}

let removeListener: (() => void) | null = null

function attachListener(view: EditorView) {
  const handler = () => {
    if (props.disabled) {
      if (visible.value) hide()
      return
    }
    const sel = view.state.selection.main
    if (sel.empty) {
      if (visible.value) hide()
      return
    }
    const text = view.state.sliceDoc(sel.from, sel.to).trim()
    if (!text) {
      if (visible.value) hide()
      return
    }
    visible.value = true
    reposition(view)
  }

  const onSelChange = () => handler()
  // Hide when focus leaves the editor (clicking elsewhere implicitly
  // collapses or moves the selection most of the time, but blur is a
  // belt-and-braces signal).
  const onBlur = () => {
    setTimeout(() => {
      if (document.activeElement?.closest('.comment-selection-popup')) return
      hide()
    }, 120)
  }

  document.addEventListener('selectionchange', onSelChange)
  view.contentDOM.addEventListener('blur', onBlur)

  removeListener = () => {
    document.removeEventListener('selectionchange', onSelChange)
    view.contentDOM.removeEventListener('blur', onBlur)
  }
}

watch(() => props.view, (view) => {
  if (removeListener) {
    removeListener()
    removeListener = null
  }
  if (view) attachListener(view)
}, { immediate: true })

// If `disabled` flips on mid-selection, hide immediately so the pill
// doesn't survive a permission downgrade.
watch(() => props.disabled, (d) => {
  if (d) hide()
})

onUnmounted(() => {
  if (removeListener) removeListener()
})

function onClick() {
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
      @click="onClick"
    >
      <UIcon
        name="i-lucide-message-circle"
        class="size-3.5 text-amber-500 shrink-0"
      />
      <span>{{ t('comments.addLabel') }}</span>
    </button>
  </div>
</template>

<style scoped>
/*
 * Same visual family as the toolbar's comment button — amber accent
 * (matches the in-doc anchor underline) on a frosted backdrop. Drops
 * the rainbow / pulse animations the AI popup had: this is a
 * lightweight one-shot trigger, not a long-running operation.
 */
.comment-selection-popup__pill {
  background: color-mix(in srgb, var(--ui-bg) 88%, transparent);
  box-shadow:
    0 0 0 1.5px color-mix(in srgb, var(--color-amber-500, #f59e0b) 45%, transparent),
    0 8px 24px -10px color-mix(in srgb, var(--color-amber-500, #f59e0b) 30%, transparent),
    0 4px 12px -4px rgb(0 0 0 / 0.15);
}

:global(.dark) .comment-selection-popup__pill {
  background: color-mix(in srgb, var(--ui-bg) 78%, transparent);
  box-shadow:
    0 0 0 1.5px color-mix(in srgb, var(--color-amber-500, #f59e0b) 55%, transparent),
    0 8px 24px -10px color-mix(in srgb, var(--color-amber-500, #f59e0b) 40%, transparent),
    0 4px 12px -4px rgb(0 0 0 / 0.45);
}

.comment-selection-popup__pill:hover {
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--color-amber-500, #f59e0b) 60%, transparent),
    0 12px 32px -10px color-mix(in srgb, var(--color-amber-500, #f59e0b) 40%, transparent),
    0 4px 12px -4px rgb(0 0 0 / 0.18);
}
</style>
