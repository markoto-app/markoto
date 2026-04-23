// Live voice dictation: mic → AudioWorklet → WebSocket → Gemini Live
// → interim/final transcripts → consumer inserts finals into the
// editor at the current caret.
//
// Deliberately thin: the consumer (`EditorLayout`) owns the editor
// view + Y.js integration, this composable just streams bytes and
// surfaces state.
//
// Built on VueUse primitives:
//   - `useUserMedia` handles MediaStream lifecycle + explicit
//     track.stop() on unmount / stop — one of the bug-prone bits we
//     hand-rolled in `useVoicePrompt.ts` (pre-audit, see TODO).
//   - `useWebSocket` handles close-on-unmount, reactive status, and
//     the buffered-send contract. Key config: `autoConnect: false`
//     AND `immediate: false`. Both options default to `true`;
//     leaving `autoConnect` on makes useWebSocket watch the URL ref
//     and re-open on every change, which — combined with an
//     explicit `.open()` call after setting the URL — spawns TWO
//     sockets per click. With both flags off we fully own the open
//     lifecycle: set URL once, call `.open()` once.

import { useUserMedia, useWebSocket } from '@vueuse/core'

export type VoiceDictationState
  = | 'idle'
    | 'requesting-permission'
    | 'connecting'
    | 'recording'
    | 'error'

export interface UseVoiceDictationOptions {
  docId: MaybeRefOrGetter<string>
  /** Called each time Gemini emits an interim transcript chunk. */
  onPartial: (text: string) => void
  /**
   * Called when Gemini finalizes a phrase. The consumer is
   * responsible for committing the text into the doc (typically via
   * a Y.js transact at the current caret).
   */
  onFinal: (text: string) => void
  /**
   * Called on any fatal error. Composable transitions to `error`
   * state; consumer should surface a toast / UI.
   */
  onError?: (message: string) => void
  /**
   * Called when the server closes us because the daily budget is
   * exhausted or the session hit its 10-min cap. Consumer typically
   * shows a friendly "out of minutes" / "session ended" UI.
   */
  onBudgetExhausted?: (remaining: number) => void
  onSessionCap?: () => void
  onIdleTimeout?: () => void
}

export function useVoiceDictation(options: UseVoiceDictationOptions) {
  const state = ref<VoiceDictationState>('idle')
  const errorMessage = ref<string | null>(null)

  // AudioContext + worklet are only created after the user clicks the
  // mic. We hold references outside reactivity because neither plays
  // well with Vue's Proxy wrapping (same reasoning as shallowRef for
  // EditorView).
  let audioCtx: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let worklet: AudioWorkletNode | null = null
  let wsUrl = ref<string | undefined>(undefined)
  let closing = false

  // VueUse: mediaStream lifecycle + track cleanup. `enabled` flips
  // with our toggle; the composable will request permission the
  // first time we set it true and reuse the granted stream after.
  const media = useUserMedia({ constraints: { audio: true } })

  // VueUse: WebSocket with buffered send, reactive status. Both
  // `immediate` and `autoConnect` are turned off so the lifecycle is
  // fully driven by our `ws.open()` call. Leaving `autoConnect` on
  // would re-open the socket every time we mutate `wsUrl`, racing
  // our explicit `open()` and producing duplicate connections.
  const ws = useWebSocket(wsUrl, {
    immediate: false,
    autoConnect: false,
    autoReconnect: false, // dictation sessions are short-lived; reconnect would mis-bill
    onConnected() {
      // `ready` message from the server triggers audio start — we
      // don't start pumping bytes until Gemini says it's ready.
    },
    onMessage(_, ev) {
      if (typeof ev.data !== 'string') return
      try {
        const msg = JSON.parse(ev.data) as { type: string, text?: string, remaining?: number }
        switch (msg.type) {
          case 'ready':
            // Now safe to start sending audio — Gemini is listening.
            void startPumping()
            break
          case 'partial':
            if (msg.text) options.onPartial(msg.text)
            break
          case 'final':
            if (msg.text) options.onFinal(msg.text)
            break
          case 'budget-exhausted':
            options.onBudgetExhausted?.(msg.remaining ?? 0)
            fail('Daily dictation budget reached.')
            break
          case 'session-cap':
            options.onSessionCap?.()
            stop()
            break
          case 'idle-timeout':
            options.onIdleTimeout?.()
            stop()
            break
          case 'error':
            fail('Transcription error.')
            break
        }
      } catch { /* ignore malformed frames */ }
    },
    onDisconnected() {
      if (!closing && state.value !== 'error') {
        // Server closed on us unexpectedly. Treat as a soft stop so
        // the UI returns to idle rather than looking stuck.
        stop()
      }
    },
    onError() {
      fail('Dictation connection error.')
    }
  })

  async function start() {
    if (state.value !== 'idle' && state.value !== 'error') return
    errorMessage.value = null
    state.value = 'requesting-permission'
    closing = false

    // Kick useUserMedia's getUserMedia call. Its own internal enabled
    // ref is SYNC-reactive, but it also exposes a `start()` that
    // awaits — we use start() so we know when the stream is live.
    let stream: MediaStream | undefined
    try {
      stream = await media.start()
    } catch (e) {
      const name = (e as { name?: string })?.name
      if (name === 'NotAllowedError') fail('Microphone permission denied.')
      else if (name === 'NotFoundError') fail('No microphone found.')
      else fail(e instanceof Error ? e.message : 'Could not access microphone.')
      return
    }
    if (!stream) {
      fail('Could not access microphone.')
      return
    }

    state.value = 'connecting'

    // Mint a short-lived JWT and open the WS. The server mints it on
    // condition of a session + doc-edit access; any 401/403 here is
    // a user-facing error we surface.
    let token: string
    try {
      const res = await $fetch<{ token: string }>('/api/ai/dictate/token', {
        method: 'POST',
        body: { docId: toValue(options.docId) }
      })
      token = res.token
    } catch (e) {
      const err = e as { data?: { message?: string }, message?: string }
      fail(err.data?.message || err.message || 'Could not authorize dictation.')
      return
    }

    wsUrl.value = buildWsUrl(token)
    ws.open()
  }

  async function startPumping() {
    // `ready` arrived. Set up the worklet graph and start piping PCM
    // chunks over the socket. `audio/pcm;rate=16000` requires the
    // AudioContext itself to run at 16 kHz — the worklet does NOT
    // resample.
    const stream = media.stream.value
    if (!stream) {
      fail('Microphone stream not available.')
      return
    }

    try {
      audioCtx = new AudioContext({ sampleRate: 16000 })
      if (audioCtx.sampleRate !== 16000) {
        // Rare but real — iOS Safari sometimes ignores the sampleRate
        // hint. We bail loudly rather than ship the wrong rate; a
        // resampler would be the proper fix for that platform later.
        fail(`Browser forced ${audioCtx.sampleRate}Hz; dictation requires 16000Hz.`)
        return
      }
      await audioCtx.audioWorklet.addModule('/worklets/pcm-recorder.js')
      source = audioCtx.createMediaStreamSource(stream)
      worklet = new AudioWorkletNode(audioCtx, 'pcm-recorder')
      worklet.port.onmessage = (ev) => {
        const pcm = (ev.data as { pcm?: ArrayBuffer }).pcm
        if (pcm && ws.status.value === 'OPEN') {
          ws.send(pcm)
        }
      }
      source.connect(worklet)
      // Don't connect worklet → destination; we don't want local
      // audio playback and `destination` would make the AudioGraph
      // run "live" which some browsers require for the worklet to
      // fire. Chrome + Firefox both pump the graph as long as there's
      // a MediaStreamSource feeding it, so source→worklet is enough.
      state.value = 'recording'
    } catch (e) {
      fail(e instanceof Error ? e.message : 'Could not start audio pipeline.')
    }
  }

  function stop() {
    if (state.value === 'idle') return
    closing = true

    // Send `stop` so Gemini can emit any pending final before teardown.
    try {
      if (ws.status.value === 'OPEN') ws.send(JSON.stringify({ type: 'stop' }))
    } catch { /* best-effort */ }

    cleanupAudioResources()
    // Defer WS close slightly so the server's stop handler + any
    // trailing `final` message land before our onDisconnected fires.
    setTimeout(() => {
      try { ws.close() } catch { /* best-effort */ }
      wsUrl.value = undefined
    }, 300)

    state.value = 'idle'
  }

  function fail(message: string) {
    cleanupAudioResources()
    try { ws.close() } catch { /* best-effort */ }
    wsUrl.value = undefined
    options.onError?.(message)
    errorMessage.value = message
    state.value = 'error'
  }

  function clearError() {
    if (state.value === 'error') {
      errorMessage.value = null
      state.value = 'idle'
    }
  }

  function toggle() {
    if (state.value === 'recording' || state.value === 'connecting' || state.value === 'requesting-permission') {
      stop()
    } else {
      void start()
    }
  }

  function cleanupAudioResources() {
    try { worklet?.disconnect() } catch { /* best-effort */ }
    worklet = null
    try { source?.disconnect() } catch { /* best-effort */ }
    source = null
    if (audioCtx && audioCtx.state !== 'closed') {
      // close() returns a promise; fire-and-forget is fine, we're
      // not racing anything that depends on completion.
      audioCtx.close().catch(() => { /* best-effort */ })
    }
    audioCtx = null
    // Release the MediaStream via VueUse so the browser mic
    // indicator clears immediately.
    media.stop()
  }

  onUnmounted(() => {
    closing = true
    cleanupAudioResources()
    try { ws.close() } catch { /* best-effort */ }
  })

  return {
    state: readonly(state),
    errorMessage: readonly(errorMessage),
    start,
    stop,
    toggle,
    clearError
  }
}

function buildWsUrl(token: string): string {
  // Respect the current page's protocol — wss:// on HTTPS, ws:// on
  // plain HTTP. Port is inherited from location.host.
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}/api/ai/dictate?token=${encodeURIComponent(token)}`
}
