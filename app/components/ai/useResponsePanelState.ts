import { ref, watch, onScopeDispose, type Ref } from 'vue'

// State machine for AIResponsePanel. Lives in its own module so the
// timer + manual-expand logic is testable without mounting the SFC
// (the test infra's `dom` project doesn't ship `@vitejs/plugin-vue`,
// and the `nuxt` project trips a `virtual:public?…svg` transform-time
// blocker that takes out every SFC test in this repo). Every bug we
// shipped on this surface was in this logic — the template just
// reads `expanded.value` and binds events.
//
// Behaviour pinned (and the bug each was already shipped):
//
//   1. Auto-collapse after `COLLAPSE_AFTER_MS` measured FROM ARRIVAL
//      (not from the server-stamped `ts`). The original
//      `Math.max(0, 2000 - (Date.now() - serverTs))` clamped to 0
//      whenever the awareness round-trip + Vue reactivity took a
//      non-trivial slice of the window — collapsing the panel
//      "almost immediately".
//
//   2. Manual re-open via the pill MUST NOT re-arm the timer. Pre-fix,
//      `expand()` called `scheduleCollapse()` which kicked off a new
//      10s window even though the user had explicitly chosen to
//      re-open the message.
//
//   3. `dismiss()` collapses to the pill without evicting the
//      response. The component intentionally has no "evict" path —
//      the latched response sticks around until a fresh
//      `message_to_user` replaces it.
//
//   4. Hover pauses the timer; pointerleave reschedules a FRESH
//      window (not "remaining time").
//
//   5. `is_question: true` responses stay sticky — no auto-collapse
//      timer scheduled.
//
//   6. A new `ts` (fresh response) clears the manual-expand opt-out
//      so the auto-collapse timer fires for the new message even if
//      the user had the pill open at the time.

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

  // Watch the response's `ts` field — every fresh arrival resets the
  // manual-expand opt-out and re-schedules from the FULL window. The
  // `immediate` flag means the watcher runs once on mount with the
  // initial source value (which may be null).
  //
  // `flush: 'sync'` makes the state machine react synchronously to
  // source changes. The default `'pre'` schedules the callback for
  // before the next render via a microtask — invisible to users
  // (microsecond delays don't show up in human reaction time) but it
  // breaks fake-timer unit tests where `vi.advanceTimersByTime` only
  // pumps `setTimeout` queues, not microtasks. The state machine is
  // genuinely synchronous (timer-driven, not render-driven), so sync
  // flush is the more honest semantic.
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
