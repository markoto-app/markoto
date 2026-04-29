<script setup lang="ts">
/**
 * Mobile-only bottom-sheet panel. Shared by every right-sidebar
 * surface (theme, comments, activity, document, knowledge, future
 * insert-sheet) so they all behave identically on mobile.
 *
 * Anatomy:
 *
 *   ┌─────────────────────────────────┐
 *   │  doc preview / editor (visible) │   ← preserved above the sheet
 *   │                                 │
 *   ├─────────────────────────────────┤
 *   │             ▬▬▬                 │   ← drag handle
 *   │  Title              ✕           │
 *   ├─────────────────────────────────┤
 *   │                                 │
 *   │  panel content (slot)            │
 *   │                                 │
 *   └─────────────────────────────────┘
 *
 * Why no backdrop: the whole point on mobile is the user can SEE the
 * preview update live as they tweak the theme. A backdrop would
 * defeat that. The visual separation is the sheet's own surface +
 * the drag-handle affordance.
 *
 * Drag-to-dismiss: pointer-down on the handle starts a drag, vertical
 * delta translates the sheet downward. Release with delta > 80px OR
 * velocity > 0.4 px/ms snaps it closed; otherwise springs back.
 *
 * Snap height: defaults to 60% viewport. Configurable via prop.
 *
 * Safe area: bottom padding picks up `env(safe-area-inset-bottom)` so
 * iPhone home-indicator doesn't overlap content.
 *
 * Body scroll lock: prevents background scroll while the sheet is
 * open. Released on close.
 *
 * Desktop fallback: when the consuming context is desktop (>=sm), the
 * caller doesn't render BottomSheet at all — it conditionals around
 * `useMediaQuery('(max-width: 639px)')` and uses the regular `<aside>`
 * layout instead. Keeping the component mobile-only avoids dual-mode
 * complexity here.
 */
import { ref, watch, onUnmounted } from 'vue'

const props = withDefaults(defineProps<{
  /** Two-way bound. The sheet is mounted only when true. */
  modelValue: boolean
  /** Heading rendered to the right of the drag handle. */
  title?: string
  /** Snap height as a CSS length (px / vh / %). Default 60vh. */
  snapHeight?: string
}>(), {
  title: '',
  snapHeight: '60vh'
})

const emit = defineEmits<{
  'update:modelValue': [boolean]
  'close': []
}>()

const sheetRef = ref<HTMLElement | null>(null)
const dragOffset = ref(0)
const dragging = ref(false)

let dragStartY = 0
let dragStartTime = 0

function close() {
  dragOffset.value = 0
  emit('update:modelValue', false)
  emit('close')
}

function onPointerDown(e: PointerEvent) {
  // Only the drag handle starts a drag — the rest of the header
  // stays interactive (close button, title text). The handle wraps
  // the touch target so taps on the visible 4px line don't require
  // pixel precision.
  if (!(e.target as HTMLElement)?.closest('[data-drag-handle]')) return
  dragging.value = true
  dragStartY = e.clientY
  dragStartTime = performance.now()
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const delta = e.clientY - dragStartY
  // Only drag DOWNWARD. Pulling up does nothing — the sheet has a
  // single snap height. Gives the drag a concrete physical meaning
  // (down = dismiss).
  dragOffset.value = Math.max(0, delta)
}

function onPointerUp(e: PointerEvent) {
  if (!dragging.value) return
  const delta = e.clientY - dragStartY
  const elapsed = performance.now() - dragStartTime
  const velocity = delta / elapsed // px/ms, downward = positive
  dragging.value = false
  ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  // Dismiss on EITHER significant distance OR fast flick. Distance
  // covers the deliberate slow-drag-to-confirm pattern; velocity
  // covers the quick swipe-flick most users default to.
  if (delta > 80 || velocity > 0.4) {
    close()
  } else {
    dragOffset.value = 0
  }
}

// Body-scroll lock — without this, scrolling within the sheet's
// content (a long theme-panel) bubbles up and scrolls the underlying
// editor too. We toggle on `overflow: hidden` on the html element
// for the duration of the open state.
watch(() => props.modelValue, (isOpen) => {
  if (typeof document === 'undefined') return
  if (isOpen) {
    document.documentElement.style.overflow = 'hidden'
  } else {
    document.documentElement.style.overflow = ''
  }
})

onUnmounted(() => {
  if (typeof document !== 'undefined') {
    document.documentElement.style.overflow = ''
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="mk-sheet">
      <div
        v-if="modelValue"
        class="mk-sheet-host"
        role="dialog"
        :aria-label="title || 'Panel'"
        aria-modal="false"
      >
        <div
          ref="sheetRef"
          class="mk-sheet"
          :style="{
            height: snapHeight,
            transform: dragOffset > 0 ? `translateY(${dragOffset}px)` : '',
            transition: dragging ? 'none' : ''
          }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <!-- Drag handle. Wider tap area than the visible bar; visible
               bar is the affordance, surrounding 24px is the touch target. -->
          <div
            data-drag-handle
            class="mk-sheet__handle-area"
            :aria-label="'Drag to close'"
          >
            <div class="mk-sheet__handle" />
          </div>

          <!-- Header. Title + close button. Distinct from desktop's
               `<header>` pattern — drag-handle does the affordance, the
               title is just informational, the close button is a
               redundant tap-to-close for users who don't drag. -->
          <header v-if="title" class="mk-sheet__header">
            <h2 class="mk-sheet__title">{{ title }}</h2>
            <button
              type="button"
              class="mk-sheet__close"
              :aria-label="'Close'"
              @click="close"
            >
              <span class="i-lucide-x" />
            </button>
          </header>

          <!-- Content. `flex-1` so it grows to fill, `overflow-y-auto`
               so it scrolls within the sheet without bubbling up. -->
          <div class="mk-sheet__content">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mk-sheet-host {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 50;
}

.mk-sheet {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  background: var(--ui-bg-default);
  border-top: 1px solid var(--ui-border);
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.12);
  /* Safe-area inset on iPhone — home indicator clearance. */
  padding-bottom: env(safe-area-inset-bottom, 0px);
  transition: transform 220ms cubic-bezier(0.32, 0.72, 0, 1);
  /* Prevents the rounded corners from being clipped by the slot
     content's overflow. */
  overflow: hidden;
}

.mk-sheet__handle-area {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 24px;
  cursor: grab;
  touch-action: none;
  flex-shrink: 0;
}
.mk-sheet__handle-area:active {
  cursor: grabbing;
}
.mk-sheet__handle {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--ui-border);
}

.mk-sheet__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px 12px 16px;
  border-bottom: 1px solid var(--ui-border);
  flex-shrink: 0;
}
.mk-sheet__title {
  font-family: var(--font-serif);
  font-size: 18px;
  font-weight: 400;
  letter-spacing: -0.01em;
  color: var(--ui-text-default);
  margin: 0;
}
.mk-sheet__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  color: var(--ui-text-muted);
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: background 120ms ease;
}
.mk-sheet__close:hover {
  background: var(--ui-bg-elevated);
}

.mk-sheet__content {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

/* Slide-up enter / slide-down leave. Pairs with the @pointerup
   `transform: translateY(...)` for drag-dismiss. */
.mk-sheet-enter-active,
.mk-sheet-leave-active {
  transition: opacity 200ms ease;
}
.mk-sheet-enter-active .mk-sheet,
.mk-sheet-leave-active .mk-sheet {
  transition: transform 220ms cubic-bezier(0.32, 0.72, 0, 1);
}
.mk-sheet-enter-from,
.mk-sheet-leave-to {
  opacity: 0;
}
.mk-sheet-enter-from .mk-sheet,
.mk-sheet-leave-to .mk-sheet {
  transform: translateY(100%);
}
</style>
