<script setup lang="ts">
/**
 * Mobile-only bottom-sheet panel, shared by every right-sidebar surface so
 * they behave identically on mobile.
 *
 * No backdrop: the user must see the preview update live while tweaking
 * the theme.
 *
 * Drag-to-dismiss: dragging the handle down more than 80px, or faster than
 * 0.4 px/ms, closes the sheet; otherwise it springs back.
 *
 * Bottom padding uses `env(safe-area-inset-bottom)` for the iPhone home
 * indicator.
 *
 * Locks body scroll while open.
 *
 * Mobile only: desktop callers don't render it and use the regular `<aside>`
 * layout (`useMediaQuery('(max-width: 639px)')`).
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
  // Only the handle starts a drag; the header's close button stays
  // interactive. The handle wraps a larger touch target than its 4px line.
  if (!(e.target as HTMLElement)?.closest('[data-drag-handle]')) return
  dragging.value = true
  dragStartY = e.clientY
  dragStartTime = performance.now()
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const delta = e.clientY - dragStartY
  // Down only: there is a single snap height, so dragging up does nothing.
  dragOffset.value = Math.max(0, delta)
}

function onPointerUp(e: PointerEvent) {
  if (!dragging.value) return
  const delta = e.clientY - dragStartY
  const elapsed = performance.now() - dragStartTime
  const velocity = delta / elapsed // px/ms, downward = positive
  dragging.value = false
  ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  // Dismiss on a long drag OR a fast flick.
  if (delta > 80 || velocity > 0.4) {
    close()
  } else {
    dragOffset.value = 0
  }
}

// Without the lock, scrolling a long panel inside the sheet scrolls the
// editor underneath too.
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
      <dialog
        v-if="modelValue"
        open
        class="mk-sheet-host"
        :aria-label="title || 'Panel'"
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
          <!-- The visible bar is the affordance; the surrounding 24px is the
               touch target. -->
          <div
            data-drag-handle
            class="mk-sheet__handle-area"
            :aria-label="$t('common.dragToClose')"
          >
            <div class="mk-sheet__handle" />
          </div>

          <header
            v-if="title"
            class="mk-sheet__header"
          >
            <h2 class="mk-sheet__title">
              {{ title }}
            </h2>
            <button
              type="button"
              class="mk-sheet__close"
              :aria-label="'Close'"
              @click="close"
            >
              <span class="i-lucide-x" />
            </button>
          </header>

          <div class="mk-sheet__content">
            <slot />
          </div>
        </div>
      </dialog>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mk-sheet-host {
  position: fixed;
  inset: 0;
  /* Reset the UA <dialog> box. Browsers style
     `dialog { width: fit-content; height: fit-content; margin: auto;
     padding: 1em; border: solid; background: canvas }`. Without an
     explicit width/height override the dialog collapses to 0×0 here —
     its only child (.mk-sheet) is position:absolute, so it contributes
     nothing to fit-content — and the absolutely-positioned sheet is then
     sized against that 0×0 box and lands off-screen (width 0, y negative).
     That was the bug: the mobile bottom sheet never appeared even though
     its open state was set. Chrome AND Firefox both ship the fit-content
     UA rule, so it reproduced on every Android browser. Filling the
     viewport + neutralising the rest of the UA dialog box fixes it. */
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
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
  /* `--ui-bg-muted` is the shared "chrome" token (toolbar, status bar,
     sidebar, this drawer); `--ui-bg` would show a step where the handle
     meets the panel body. */
  background: var(--ui-bg-muted);
  border-top: 1px solid var(--ui-border);
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.12);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  transition: transform 220ms cubic-bezier(0.32, 0.72, 0, 1);
  /* Keeps the rounded corners from being clipped by slot content. */
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
  color: var(--ui-text);
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
