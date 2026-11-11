import { ref, watch, onScopeDispose, type Ref } from 'vue'

// State machine for AIResponsePanel. Lives in its own module so the
// timer + manual-expand logic is testable without mounting the SFC (the
// `dom` test project has no `@vitejs/plugin-vue`, and the `nuxt` project
// trips a `virtual:public?…svg` transform-time blocker for every SFC
// test). The template just reads `expanded.value` and binds events.
//
// Behaviour pinned by tests:
//
//   1. Auto-collapse after `COLLAPSE_AFTER_MS`, measured FROM ARRIVAL
//      (not from the server-stamped `ts`): the awareness round-trip
//      plus Vue reactivity can eat most of a `ts`-based window and
//      collapse the panel almost immediately.
//
//   2. Manual re-open via the pill MUST NOT re-arm the timer; the user
//      explicitly chose to keep the message open.
//
//   3. `dismiss()` collapses to the pill without evicting the response.
//      There is no "evict" path: the latched response stays until a
//      fresh `message_to_user` replaces it.
//
//   4. Hover pauses the timer; pointerleave starts a FRESH window (not
//      the remaining time).
//
//   5. `is_question: true` responses stay sticky: no timer is scheduled.
//
//   6. A new `ts` (fresh response) clears the manual-expand opt-out so
//      the timer fires for the new message even if the pill was open.

export interface ResponsePanelStateInput<T> {
  /** Reactive source for the current response. The state machine
   *  watches `value?.ts ?? null` to detect fresh arrivals. */
  source: Ref<T | null>
  /** Predicate: returns true when this response should stay sticky
   *  (no auto-collapse timer). For `message_to_user` callers, this
   *  is `r => r.isQuestion === true`. */
  isQuestion: (response: T) => boolean
  /** Auto-collapse window in ms. Defaults to 10_000. */
  collapseAfterMs?: number
  /** Optional clock injection — tests use Date.now via vi.useFakeTimers
   *  by default, but a callback hook makes the timing explicit too. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
}

export interface ResponsePanelState {
  /** True when the expanded card should render; false when the pill
   *  (or nothing) should render instead. */
  expanded: Ref<boolean>
  /** True after the user clicked the pill to re-open. Cleared by a
   *  fresh response or by `dismiss()`. Mainly exposed for the
   *  parent's wrapper-class mirroring. */
  manuallyExpanded: Ref<boolean>
  /** Manual re-open (pill click). Sets manuallyExpanded=true so the
   *  auto-collapse timer is suppressed. */
  expand: () => void
  /** × button. Collapses to the pill and clears the manual-expand
   *  flag — does NOT evict the response itself (parent owns the
   *  latched value). */
  dismiss: () => void
  /** Pointer-enter handler — pauses the auto-collapse timer. */
  onPointerEnter: () => void
  /** Pointer-leave handler — resumes a FRESH auto-collapse window
   *  from this moment. */
  onPointerLeave: () => void
}

const DEFAULT_COLLAPSE_AFTER_MS = 10_000

export function useResponsePanelState<T extends { ts: number }>(
  input: ResponsePanelStateInput<T>
): ResponsePanelState {
  const collapseAfterMs = input.collapseAfterMs ?? DEFAULT_COLLAPSE_AFTER_MS
  const setTimeoutImpl = input.setTimeoutFn ?? setTimeout
  const clearTimeoutImpl = input.clearTimeoutFn ?? clearTimeout

  const expanded = ref(true)
  const isHovered = ref(false)
  const manuallyExpanded = ref(false)

  // The injected setTimeout/clearTimeout share a handle that may be
  // a Node Timeout (server / vitest fake timers) or a number
  // (browser). Use `unknown` here and rely on the injected pair to
  // round-trip the same handle shape on both sides — TypeScript
  // can't unify the two without an explicit any/unknown bridge.
  let collapseTimer: unknown = null

  function clearCollapseTimer() {
    if (collapseTimer !== null) {
      clearTimeoutImpl(collapseTimer as Parameters<typeof clearTimeoutImpl>[0])
      collapseTimer = null
    }
  }

  function scheduleCollapse() {
    clearCollapseTimer()
    const r = input.source.value
    if (!r) return
    if (input.isQuestion(r)) return
    if (isHovered.value) return
    if (manuallyExpanded.value) return
    collapseTimer = setTimeoutImpl(() => {
      expanded.value = false
    }, collapseAfterMs)
  }

  // Every fresh arrival (new `ts`) resets the manual-expand opt-out and
  // schedules from the FULL window. `immediate` runs the watcher once on
  // mount with the initial source value (which may be null).
  //
  // `flush: 'sync'` because the state machine is timer-driven, not
  // render-driven. The default `'pre'` defers the callback via a
  // microtask, which breaks fake-timer unit tests:
  // `vi.advanceTimersByTime` pumps `setTimeout` queues, not microtasks.
  watch(
    () => input.source.value?.ts ?? null,
    () => {
      clearCollapseTimer()
      const r = input.source.value
      if (!r) {
        expanded.value = false
        manuallyExpanded.value = false
        return
      }
      manuallyExpanded.value = false
      expanded.value = true
      scheduleCollapse()
    },
    { immediate: true, flush: 'sync' }
  )

  // `onScopeDispose` instead of `onBeforeUnmount`: works inside both
  // a component setup AND a bare `effectScope()` (which unit tests
  // use to avoid mounting an SFC). `onBeforeUnmount` is no-op
  // outside a component context, leaving timers leaked.
  onScopeDispose(clearCollapseTimer)

  function expand() {
    manuallyExpanded.value = true
    expanded.value = true
  }

  function dismiss() {
    clearCollapseTimer()
    manuallyExpanded.value = false
    expanded.value = false
  }

  function onPointerEnter() {
    isHovered.value = true
    clearCollapseTimer()
  }

  function onPointerLeave() {
    isHovered.value = false
    scheduleCollapse()
  }

  return { expanded, manuallyExpanded, expand, dismiss, onPointerEnter, onPointerLeave }
}
