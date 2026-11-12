// Live voice dictation: mic → AudioWorklet → WebSocket → Mistral
// Voxtral Realtime → interim/final transcripts → consumer inserts
// finals into the editor at the current caret.
//
// Deliberately thin: the consumer (`EditorLayout`) owns the editor
// view + Y.js integration, this composable just streams bytes and
// surfaces state.
//
// Built on VueUse primitives:
//   - `useUserMedia` handles MediaStream lifecycle + explicit
//     track.stop() on unmount / stop.
//   - `useWebSocket` handles close-on-unmount, reactive status, and
//     buffered send. Both `autoConnect` and `immediate` must be false:
//     with `autoConnect` on it re-opens whenever the URL ref changes,
//     which together with our explicit `.open()` spawns TWO sockets
//     per click. With both off, set the URL once and call `.open()` once.

import { useUserMedia, useWebSocket, useVibrate } from '@vueuse/core'
import {
  encodeClientFrame,
  type DictateServerFrame
} from '~~/shared/contracts/dictateWs'

export type VoiceDictationState
  = | 'idle'
    | 'requesting-permission'
    | 'connecting'
    | 'recording'
    | 'error'

export interface UseVoiceDictationOptions {
  docId: MaybeRefOrGetter<string>
  /** Called each time Voxtral emits an interim transcript chunk. */
  onPartial: (text: string) => void
  /**
   * Called when Voxtral finalizes a phrase. The consumer is
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
  // `useI18n()` must run synchronously during setup (it throws inside an
  // async click handler); `locale.value` is read lazily so language changes
  // are still picked up.
  const { locale, t } = useI18n()
  const { extractError } = useErrorHandler()

  const state = ref<VoiceDictationState>('idle')
  const errorMessage = ref<string | null>(null)

  // Created after the user clicks the mic. Held outside reactivity because
  // neither plays well with Vue's Proxy wrapping.
  let audioCtx: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let worklet: AudioWorkletNode | null = null
  const wsUrl = ref<string | undefined>(undefined)
  let closing = false
  const _connectWatchdog: ReturnType<typeof setTimeout> | null = null

  const media = useUserMedia({ constraints: { audio: true } })

  // Haptics: one short tap on start, a double tap on stop; no-op where
  // unsupported (iOS). Patterns are passed per call because
  // UseVibrateOptions.interval is non-optional in the upstream typings.
  const { vibrate } = useVibrate()

  // Sent as the FIRST message after `open` rather than as a URL query param,
  // which keeps the JWT out of access logs, browser history and `Referer`.
  let pendingAuth: { token: string, languageCode?: string } | null = null

  const ws = useWebSocket(wsUrl, {
    immediate: false,
    autoConnect: false,
    autoReconnect: false, // a reconnect would start a second billed session
    onConnected(socket) {
      // Must be the first frame: the server closes the socket if it
      // doesn't arrive within 5s.
      if (pendingAuth) {
        socket.send(encodeClientFrame({ type: 'auth', ...pendingAuth }))
      }
    },
    onMessage(_, ev) {
      if (typeof ev.data !== 'string') return
      try {
        // Typed against the shared union so a new server frame type must be handled here.
        const msg = JSON.parse(ev.data) as DictateServerFrame
        switch (msg.type) {
          case 'hello':
            // Auth was already sent in `onConnected`; nothing to do.
            break
          case 'ready':
            // Auth + STT stream both up — safe to start sending audio.
            void startPumping()
            break
          case 'partial':
            if (msg.text) options.onPartial(msg.text)
            break
          case 'final':
            if (msg.text) options.onFinal(msg.text)
            break
          case 'budget-exhausted':
            options.onBudgetExhausted?.(msg.remaining)
            fail(t('ai.dictateBudgetExhaustedTitle'))
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
            fail(t('ai.voiceErrors.transcription'))
            break
        }
      } catch { /* ignore malformed frames */ }
    },
    onDisconnected() {
      if (!closing && state.value !== 'error') {
        // Unexpected server close: soft stop so the UI doesn't look stuck.
        stop()
      }
    },
    onError() {
      fail(t('ai.voiceErrors.dictationConnection'))
    }
  })

  async function start() {
    if (state.value !== 'idle' && state.value !== 'error') return
    errorMessage.value = null
    state.value = 'requesting-permission'
    closing = false

    // `start()` (not the `enabled` ref) so we know when the stream is live.
    let stream: MediaStream | undefined
    try {
      stream = await media.start()
    } catch (e) {
      const name = (e as { name?: string })?.name
      if (name === 'NotAllowedError') fail(t('ai.voiceErrors.micDenied'))
      else if (name === 'NotFoundError') fail(t('ai.voiceErrors.micNotFound'))
      else fail(t('ai.voiceErrors.micAccess'))
      return
    }
    if (!stream) {
      fail(t('ai.voiceErrors.micAccess'))
      return
    }

    state.value = 'connecting'

    // Short-lived JWT, minted over POST so it never appears in a URL or log.
    let token: string
    try {
      const res = await apiFetch('/api/ai/dictate/token', {
        method: 'post',
        body: { docId: toValue(options.docId) }
      })
      token = res.token
    } catch (e) {
      fail(extractError(e).message)
      return
    }

    // Sent by onConnected as the first WS frame; the UI locale rides along
    // so Voxtral transcribes in the user's language.
    pendingAuth = { token, languageCode: locale.value }
    wsUrl.value = buildWsUrl()
    ws.open()
  }

  async function startPumping() {
    // `audio/pcm;rate=16000` requires the AudioContext itself to run at
    // 16 kHz; the worklet does not resample.
    const stream = media.stream.value
    if (!stream) {
      fail(t('ai.voiceErrors.streamUnavailable'))
      return
    }

    try {
      audioCtx = new AudioContext({ sampleRate: 16000 })
      if (audioCtx.sampleRate !== 16000) {
        // iOS Safari sometimes ignores the sampleRate hint. Fail rather
        // than send the wrong rate (a resampler would be the fix).
        fail(t('ai.voiceErrors.sampleRate', { rate: audioCtx.sampleRate }))
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
      // Not connected to `destination`: no local playback, and Chrome and
      // Firefox pump the graph as long as a MediaStreamSource feeds it.
      state.value = 'recording'
      vibrate(50)
    } catch {
      fail(t('ai.voiceErrors.pipeline'))
    }
  }

  function stop() {
    if (state.value === 'idle') return
    if (state.value === 'recording') vibrate([75, 20, 75])
    closing = true

    // Lets Voxtral emit any pending final before teardown.
    try {
      if (ws.status.value === 'OPEN') ws.send(encodeClientFrame({ type: 'stop' }))
    } catch { /* best-effort */ }

    cleanupAudioResources()
    // Delay the close so the trailing `final` lands before onDisconnected fires.
    setTimeout(() => {
      try {
        ws.close()
      } catch { /* best-effort */ }
      wsUrl.value = undefined
    }, 300)

    state.value = 'idle'
  }

  function fail(message: string) {
    cleanupAudioResources()
    try {
      ws.close()
    } catch { /* best-effort */ }
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
    try {
      worklet?.disconnect()
    } catch { /* best-effort */ }
    worklet = null
    try {
      source?.disconnect()
    } catch { /* best-effort */ }
    source = null
    if (audioCtx && audioCtx.state !== 'closed') {
      audioCtx.close().catch(() => { /* best-effort */ })
    }
    audioCtx = null
    // Clears the browser's mic indicator immediately.
    media.stop()
  }

  onUnmounted(() => {
    closing = true
    cleanupAudioResources()
    try {
      ws.close()
    } catch { /* best-effort */ }
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

function buildWsUrl(): string {
  // The auth token is deliberately not in the URL; see `pendingAuth`.
  const scheme = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${globalThis.location.host}/api/ai/dictate`
}
