import { useWebSocket } from '@vueuse/core'
import { encodeClientFrame } from '~~/shared/contracts/dictateWs'
import { dispatchDictationFrame, type DictationFrameHandlers } from './dictationPipeline'

/**
 * The WebSocket to the dictation relay (`/api/ai/dictate`), for
 * `useVoiceDictation`. `useWebSocket` handles close-on-unmount, reactive
 * status and buffered send. Both `autoConnect` and `immediate` must be
 * false: with `autoConnect` on it re-opens whenever the URL ref changes,
 * which together with our explicit `.open()` spawns TWO sockets per click.
 * With both off, the URL is set once and `.open()` called once.
 */
export function useDictationSocket(on: DictationFrameHandlers & {
  /** The socket closed (by the server or by `close()`). */
  onDisconnected: () => void
  onSocketError: () => void
}) {
  const url = ref<string | undefined>(undefined)
  // Sent as the FIRST message after `open` rather than as a URL query param,
  // which keeps the JWT out of access logs, browser history and `Referer`.
  let pendingAuth: { token: string, languageCode?: string } | null = null

  const ws = useWebSocket(url, {
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
      dispatchDictationFrame(ev.data, on)
    },
    onDisconnected() {
      on.onDisconnected()
    },
    onError() {
      on.onSocketError()
    }
  })

  function open(auth: { token: string, languageCode?: string }): void {
    pendingAuth = auth
    url.value = buildWsUrl()
    ws.open()
  }

  function sendPcm(pcm: ArrayBuffer): void {
    if (ws.status.value === 'OPEN') ws.send(pcm)
  }

  /** Lets Voxtral emit any pending final before teardown. */
  function sendStop(): void {
    try {
      if (ws.status.value === 'OPEN') ws.send(encodeClientFrame({ type: 'stop' }))
    } catch { /* best-effort */ }
  }

  function close(): void {
    try {
      ws.close()
    } catch { /* best-effort */ }
    url.value = undefined
  }

  return { open, sendPcm, sendStop, close }
}

function buildWsUrl(): string {
  // The auth token is deliberately not in the URL; see `pendingAuth`.
  const scheme = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${globalThis.location.host}/api/ai/dictate`
}
