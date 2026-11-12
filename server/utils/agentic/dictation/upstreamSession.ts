import * as Sentry from '@sentry/nuxt'
import { createDictateRealtimeClient, type SpeechStream } from '../dictateSpeechClient'
import type { LiveDictationTarget } from '../../aiProviders/resolve'
import { encodeServerFrame } from '~~/shared/contracts/dictateWs'
import { useLogger } from '../../platform/logger'
import { rejectPeer, type DictatePeerContext, type PeerLike } from './peerContext'

const log = useLogger('dictate')

// The upstream transcription stream (Mistral Voxtral Realtime via the
// official SDK, or the test-mode mock): opened after auth, its transcript
// events relayed to the browser as `partial` / `final` frames.

/** Open the stream, or refuse the peer and return null when it can't start. */
export function openSttStream(peer: PeerLike, ctx: DictatePeerContext, target: LiveDictationTarget, lang: string): SpeechStream | null {
  const client = createDictateRealtimeClient(target.apiKey, target.model, target.serverURL)
  let sttStream: SpeechStream
  try {
    sttStream = client.streamingRecognize({
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: lang,
        enableAutomaticPunctuation: true,
        model: 'latest_long'
      },
      interimResults: true
    })
  } catch (e) {
    log.error('streamingRecognize init failed', { err: e })
    Sentry.captureException(e, {
      tags: { component: 'dictate', event: 'stt_init_failed' }
    })
    rejectPeer(peer, 'Could not start transcription session', 1011, 'stt init failed')
    return null
  }
  relayTranscripts(peer, ctx, sttStream)
  return sttStream
}

function relayTranscripts(peer: PeerLike, ctx: DictatePeerContext, sttStream: SpeechStream): void {
  sttStream.on('data', (raw) => {
    const data = raw as {
      results?: Array<{
        alternatives?: Array<{ transcript?: string }>
        isFinal?: boolean
      }>
    }
    const r = data.results?.[0]
    const text = r?.alternatives?.[0]?.transcript
    if (!text) return
    peer.send(encodeServerFrame({ type: r?.isFinal ? 'final' : 'partial', text }))
  })

  sttStream.on('error', (err) => {
    const msg = (err as { message?: string })?.message ?? 'transcription error'
    // "write after end" is expected if the client fired stop and a
    // stray audio chunk slipped past the `sttEnded` guard. Drop it
    // silently: surfacing it as a UI error on the client would show
    // a toast for what was really a clean shutdown.
    if (ctx.sttEnded && /write after end/i.test(msg)) return
    log.error('stt error', { err })
    Sentry.captureException(err, {
      tags: { component: 'dictate', event: 'stt_stream_error' }
    })
    if (!ctx.closed) {
      rejectPeer(peer, msg, 1011, 'stt error')
    }
  })
  sttStream.on('end', () => {
    if (!ctx.closed) peer.close(1000, 'stt ended')
  })
}
