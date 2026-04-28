// `v-long-press="handler"` — fires `handler(event)` after `delay` ms
// of continuous pointerdown without movement past `tolerance` px.
// Movement / pointerup / pointercancel before the threshold cancels.
//
// Why a custom directive instead of VueUse's `vOnLongPress`: the
// directive form ships in `@vueuse/components`, which isn't a
// dependency. The composable form (`onLongPress`) only binds to a
// single element ref and can't be used across a `v-for`. This 30-line
// directive lets list rows attach long-press without restructuring
// the loop.
//
// Default mobile-friendly: 500 ms hold, 8 px movement tolerance.
// Modifiers `:600` / `:1000` (delay ms) and `.tolerance.16` would be
// the natural extension; for now the call sites tune by passing
// `[handler, { delay, tolerance }]`.

import type { DirectiveBinding } from 'vue'

interface LongPressOptions {
  delay?: number
  tolerance?: number
}

interface LongPressState {
  timer: ReturnType<typeof setTimeout> | null
  startX: number
  startY: number
  pointerDown: (e: PointerEvent) => void
  pointerUp: () => void
  pointerMove: (e: PointerEvent) => void
}

const states = new WeakMap<HTMLElement, LongPressState>()

function resolve(value: unknown): { handler: (e: PointerEvent) => void, options: LongPressOptions } {
  if (typeof value === 'function') return { handler: value as (e: PointerEvent) => void, options: {} }
  if (Array.isArray(value)) return { handler: value[0] as (e: PointerEvent) => void, options: (value[1] as LongPressOptions) ?? {} }
  return { handler: () => {}, options: {} }
}

function mount(el: HTMLElement, binding: DirectiveBinding) {
  const { handler, options } = resolve(binding.value)
  const delay = options.delay ?? 500
  const tolerance = options.tolerance ?? 8

  const state: LongPressState = {
    timer: null,
    startX: 0,
    startY: 0,
    pointerDown(e) {
      // Only primary pointer (left mouse / first touch). Skip the
      // secondary buttons so right-click doesn't double-fire on
      // desktop where the native context menu already handles it.
      if (e.button !== undefined && e.button !== 0) return
      state.startX = e.clientX
      state.startY = e.clientY
      state.timer = setTimeout(() => {
        state.timer = null
        handler(e)
      }, delay)
    },
    pointerMove(e) {
      if (state.timer === null) return
      const dx = e.clientX - state.startX
      const dy = e.clientY - state.startY
      if (dx * dx + dy * dy > tolerance * tolerance) {
        clearTimeout(state.timer)
        state.timer = null
      }
    },
    pointerUp() {
      if (state.timer !== null) {
        clearTimeout(state.timer)
        state.timer = null
      }
    }
  }
  el.addEventListener('pointerdown', state.pointerDown)
  el.addEventListener('pointermove', state.pointerMove)
  el.addEventListener('pointerup', state.pointerUp)
  el.addEventListener('pointercancel', state.pointerUp)
  states.set(el, state)
}

function unmount(el: HTMLElement) {
  const s = states.get(el)
  if (!s) return
  if (s.timer !== null) clearTimeout(s.timer)
  el.removeEventListener('pointerdown', s.pointerDown)
  el.removeEventListener('pointermove', s.pointerMove)
  el.removeEventListener('pointerup', s.pointerUp)
  el.removeEventListener('pointercancel', s.pointerUp)
  states.delete(el)
}

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.directive('long-press', {
    mounted: mount,
    updated(el, binding) {
      if (binding.value === binding.oldValue) return
      unmount(el)
      mount(el, binding)
    },
    unmounted: unmount
  })
})
