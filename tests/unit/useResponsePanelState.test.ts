import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, ref, type Ref } from 'vue'
import { useResponsePanelState } from '../../app/components/ai/useResponsePanelState'

// State machine for `AIResponsePanel.vue`. Tests pin every behaviour
// the SFC ships and every bug we already shipped on this surface:
//
//   - Auto-collapse fires after the configured window (10s default)
//     when measured FROM ARRIVAL, not from the server-stamped ts.
//   - Manual re-open via the pill MUST NOT auto-collapse — the
//     user opted in.
//   - × dismiss collapses + clears the manual flag, but does NOT
//     evict the response (parent owns the latched value).
//   - Hover pauses; pointerleave reschedules a fresh full window.
//   - is_question=true responses stay sticky.
//   - A fresh `ts` resets the manual-expand opt-out.
//   - Null source = collapsed, no timer.
//
// The composable uses `onBeforeUnmount`, so it must be invoked inside
// an effect scope. Each test wraps construction in
// `effectScope().run(...)` so the watcher is set up properly and
// cleanup happens deterministically at scope.stop().

interface MockResponse {
  ts: number
  isQuestion: boolean
  message: string
}

function withScope<T>(fn: () => T): { value: T, stop: () => void } {
  const scope = effectScope()
  let v!: T
  scope.run(() => {
    v = fn()
  })
  return {
    value: v,
    stop: () => scope.stop()
  }
}

describe('useResponsePanelState', () => {
  let source: Ref<MockResponse | null>

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    source = ref<MockResponse | null>(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function setResponse(over: Partial<MockResponse> = {}) {
    source.value = {
      ts: Date.now(),
      isQuestion: false,
      message: 'hi',
      ...over
    }
  }

  it('starts collapsed when source is null', () => {
    const { value: state } = withScope(() => useResponsePanelState({
      source,
      isQuestion: r => r.isQuestion === true
    }))
    expect(state.expanded.value).toBe(false)
    expect(state.manuallyExpanded.value).toBe(false)
  })

  it('expands when a response arrives, schedules the auto-collapse', () => {
    const { value: state } = withScope(() => useResponsePanelState({
      source,
      isQuestion: r => r.isQuestion === true
    }))

    setResponse()
    expect(state.expanded.value).toBe(true)
    expect(state.manuallyExpanded.value).toBe(false)

    vi.advanceTimersByTime(10_000 - 1)
    expect(state.expanded.value).toBe(true)

    vi.advanceTimersByTime(2)
    expect(state.expanded.value).toBe(false)
  })

  it('does NOT schedule auto-collapse for is_question=true responses', () => {
    const { value: state } = withScope(() => useResponsePanelState({
      source,
      isQuestion: r => r.isQuestion === true
    }))
    setResponse({ isQuestion: true })
    expect(state.expanded.value).toBe(true)
    vi.advanceTimersByTime(10_000 * 5)
    expect(state.expanded.value).toBe(true)
  })

  it('respects a custom collapseAfterMs', () => {
    const { value: state } = withScope(() => useResponsePanelState({
      source,
      isQuestion: r => r.isQuestion === true,
      collapseAfterMs: 3_000
    }))
    setResponse()
    vi.advanceTimersByTime(2_999)
    expect(state.expanded.value).toBe(true)
    vi.advanceTimersByTime(2)
    expect(state.expanded.value).toBe(false)
  })

  describe('expand() — manual pill click', () => {
    it('re-opens the card and DOES NOT re-arm the auto-collapse', () => {
      const { value: state } = withScope(() => useResponsePanelState({
        source,
        isQuestion: r => r.isQuestion === true
      }))
      setResponse()

      vi.advanceTimersByTime(10_001)
      expect(state.expanded.value).toBe(false)

      state.expand()
      expect(state.expanded.value).toBe(true)
      expect(state.manuallyExpanded.value).toBe(true)

      // Three full windows pass — manual-open must stay open.
      vi.advanceTimersByTime(10_000 * 3)
      expect(state.expanded.value).toBe(true)
    })
  })

  describe('dismiss() — × button', () => {
    it('collapses to "not expanded" without nulling the response (parent owns eviction)', () => {
      const { value: state } = withScope(() => useResponsePanelState({
        source,
        isQuestion: r => r.isQuestion === true
      }))
      setResponse({ message: 'still latched' })

      state.dismiss()
      expect(state.expanded.value).toBe(false)

      // Source ref is the parent's latched value — dismiss MUST NOT
      // touch it. The pre-fix bug evicted it; this assertion pins
      // that the composable doesn't reach back into the parent's
      // ref.
      expect(source.value?.message).toBe('still latched')
    })

    it('clears manuallyExpanded so the next dismiss/expand cycle is clean', () => {
      const { value: state } = withScope(() => useResponsePanelState({
        source,
        isQuestion: r => r.isQuestion === true
      }))
      setResponse()
      state.expand()
      expect(state.manuallyExpanded.value).toBe(true)
      state.dismiss()
      expect(state.manuallyExpanded.value).toBe(false)
    })
  })

  describe('a fresh response (new ts)', () => {
    it('resets manuallyExpanded and re-arms the auto-collapse', () => {
      const { value: state } = withScope(() => useResponsePanelState({
        source,
        isQuestion: r => r.isQuestion === true
      }))
      // First response → user dismisses → re-opens via pill → manuallyExpanded=true
      setResponse({ ts: 1_000 })
      state.dismiss()
      state.expand()
      expect(state.manuallyExpanded.value).toBe(true)

      // Second response arrives. The watcher must reset
      // manuallyExpanded so the auto-collapse fires for the new msg.
      source.value = { ts: 2_000, isQuestion: false, message: 'newer' }
      expect(state.manuallyExpanded.value).toBe(false)
      expect(state.expanded.value).toBe(true)

      vi.advanceTimersByTime(10_001)
      expect(state.expanded.value).toBe(false)
    })

    it('does NOT consider an unchanged ts a "fresh response"', () => {
      // The watcher keys on `ts`. A re-render of the same response
      // (parent re-sets source to an equal-ts value) shouldn't reset
      // the timer. Otherwise: every parent re-render restarts the
      // 10s window, breaking the user's reading time.
      const { value: state } = withScope(() => useResponsePanelState({
        source,
        isQuestion: r => r.isQuestion === true
      }))
      const fixed = { ts: 1_234, isQuestion: false, message: 'A' }
      source.value = fixed

      vi.advanceTimersByTime(5_000)
      // Re-assign with the same ts — should NOT re-arm.
      source.value = { ...fixed }

      vi.advanceTimersByTime(5_001)
      expect(state.expanded.value).toBe(false)
    })
  })

  describe('hover pause / leave reschedule', () => {
    it('pointerenter pauses the timer indefinitely', () => {
      const { value: state } = withScope(() => useResponsePanelState({
        source,
        isQuestion: r => r.isQuestion === true
      }))
      setResponse()
      vi.advanceTimersByTime(5_000)
      state.onPointerEnter()
      vi.advanceTimersByTime(10_000 * 5)
      expect(state.expanded.value).toBe(true)
    })

    it('pointerleave reschedules a FRESH full window', () => {
      const { value: state } = withScope(() => useResponsePanelState({
        source,
        isQuestion: r => r.isQuestion === true
      }))
      setResponse()
      vi.advanceTimersByTime(8_000)
      state.onPointerEnter()
      vi.advanceTimersByTime(10_000 * 3)
      state.onPointerLeave()

      // Half the new window — still open.
      vi.advanceTimersByTime(5_000)
      expect(state.expanded.value).toBe(true)
      // Past the new full window — collapses.
      vi.advanceTimersByTime(5_001)
      expect(state.expanded.value).toBe(false)
    })

    it('pointerleave does NOT schedule when manually expanded', () => {
      const { value: state } = withScope(() => useResponsePanelState({
        source,
        isQuestion: r => r.isQuestion === true
      }))
      setResponse()
      state.dismiss()
      state.expand()

      state.onPointerEnter()
      state.onPointerLeave()
      vi.advanceTimersByTime(10_000 * 3)
      expect(state.expanded.value).toBe(true)
    })

    it('pointerleave does NOT schedule for a question response', () => {
      const { value: state } = withScope(() => useResponsePanelState({
        source,
        isQuestion: r => r.isQuestion === true
      }))
      setResponse({ isQuestion: true })

      state.onPointerEnter()
      state.onPointerLeave()
      vi.advanceTimersByTime(10_000 * 3)
      expect(state.expanded.value).toBe(true)
    })
  })

  describe('source going null', () => {
    it('collapses + clears state when the response is removed', () => {
      const { value: state } = withScope(() => useResponsePanelState({
        source,
        isQuestion: r => r.isQuestion === true
      }))
      setResponse()
      state.expand()
      expect(state.manuallyExpanded.value).toBe(true)

      source.value = null
      expect(state.expanded.value).toBe(false)
      expect(state.manuallyExpanded.value).toBe(false)
    })
  })

  describe('cleanup', () => {
    it('clears the pending timer when the effect scope stops', () => {
      // After scope.stop() the onBeforeUnmount hook should fire,
      // clearing any pending timer. We assert by advancing past the
      // window and checking the expanded ref hasn't been mutated
      // (it was true at scope-stop time, no timer firing flips it).
      const { value: state, stop } = withScope(() => useResponsePanelState({
        source,
        isQuestion: r => r.isQuestion === true
      }))
      setResponse()
      expect(state.expanded.value).toBe(true)
      stop()
      vi.advanceTimersByTime(10_000 * 3)
      // Timer was cleared by onBeforeUnmount → expanded stays at the
      // last value before scope-stop.
      expect(state.expanded.value).toBe(true)
    })
  })
})
