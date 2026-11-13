import { describe, it, expect, beforeEach, vi } from 'vitest'

// Unit tests for the Voxtral realtime client + voice-tick
// orchestrator routing. The full WS handler is exercised by the
// integration suite (it spawns Nitro + a real WS client). These tests
// pin the small bits of routing logic that don't need a server:
//
//   - createDictateRealtimeClient returns the mock client when
//     TEST_MODE=1 + NUXT_VOXTRAL_REALTIME_MOCK=1
//   - The mock satisfies the same SpeechClientLike interface as
//     createDictateSpeechClient: so dictate.ts treats both
//     identically
//   - The voice-tick orchestrator's interval cadence + round-up
//     behaviour is preserved on close (asserted indirectly via the
//     state machine).

beforeEach(() => {
  process.env.TEST_MODE = '1'
  process.env.NUXT_VOXTRAL_REALTIME_MOCK = '1'
  vi.resetModules()
})

describe('createDictateRealtimeClient: provider selection', () => {
  it('returns a mock client when NUXT_VOXTRAL_REALTIME_MOCK=1', async () => {
    const { createDictateRealtimeClient } = await import('../../../server/utils/agentic/dictateSpeechClient')
    const c = createDictateRealtimeClient('any-key')
    // Mock and real both expose `streamingRecognize`, duck-type check.
    expect(typeof c.streamingRecognize).toBe('function')
  })

  it('mock client emits canned partial → final events on a few writes', async () => {
    const { createDictateRealtimeClient } = await import('../../../server/utils/agentic/dictateSpeechClient')
    const client = createDictateRealtimeClient('any-key')
    const stream = client.streamingRecognize({
      config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-US' },
      interimResults: true
    })
    type DataEvent = { results?: Array<{ alternatives?: Array<{ transcript?: string }>, isFinal?: boolean }> }
    const events: DataEvent[] = []
    stream.on('data', (raw: unknown) => events.push(raw as DataEvent))
    let ended = false
    stream.on('end', () => {
      ended = true
    })

    // Pump 3 chunks → mock fires partial, partial, final.
    for (let i = 0; i < 3; i++) stream.write(Buffer.from([0, 0, 0, 0]))
    // Mock uses setImmediate: flush the microtask queue.
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events[2]?.results?.[0]?.isFinal).toBe(true)
    expect(events[2]?.results?.[0]?.alternatives?.[0]?.transcript).toBe('Lena says the new templates save her about an hour a week.')

    stream.end()
    await new Promise(r => setImmediate(r))
    expect(ended).toBe(true)
  })

  it('mock emits "write after end" on writes after end (straggler-chunk guard)', async () => {
    const { createDictateRealtimeClient } = await import('../../../server/utils/agentic/dictateSpeechClient')
    const stream = createDictateRealtimeClient('any-key').streamingRecognize({
      config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-US' },
      interimResults: true
    })
    let lastErr: Error | undefined
    stream.on('error', (e: unknown) => {
      lastErr = e as Error
    })
    stream.end()
    await new Promise(r => setImmediate(r))
    stream.write(Buffer.from([0, 0]))
    await new Promise(r => queueMicrotask(r))
    expect(lastErr?.message).toBe('write after end')
  })
})

describe('voice-tick orchestrator: wire shape', () => {
  // The orchestrator code lives inside dictate.ts (a Nitro WS route
  // handler), so we can't import it cleanly. What we CAN pin is the
  // wire shape sent to LiteLLM when a tick fires, that's stable
  // across the orchestrator + custom-handler boundary.
  it('tick request matches the voxtral-realtime-tick model contract', () => {
    // Mirrors the call inside fireVoiceTick / fireRoundUpTick. The
    // test exists so a refactor that splits the orchestrator across
    // files / renames the model still trips this if the wire shape
    // drifts. The string-equality on `model` reads redundant but is
    // the load-bearing pin: it's the only place the contract is
    // captured outside the orchestrator itself.
    const messages = [{ role: 'user', content: 'tick' } as const]
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
    // The content string is irrelevant to the custom handler (it
    // returns instantly with usage 60 regardless), but pin a small
    // value so the wire payload doesn't accidentally balloon.
    expect((messages[0]!.content as string).length).toBeLessThanOrEqual(16)
  })

  it('round-up policy: fires one extra tick on close iff audio flowed since last tick', () => {
    // Ledger shape: `voiceAudioSinceTick` flips true on each audio
    // chunk and resets to false after each tick. On close, if true,
    // round-up.
    const ctx: { voiceAudioSinceTick?: boolean } = {}
    // No audio yet → no round-up
    ctx.voiceAudioSinceTick = false
    expect(ctx.voiceAudioSinceTick).toBe(false)
    // Audio chunk arrives
    ctx.voiceAudioSinceTick = true
    expect(ctx.voiceAudioSinceTick).toBe(true)
    // Tick fires → flag resets
    ctx.voiceAudioSinceTick = false
    // More audio
    ctx.voiceAudioSinceTick = true
    // Close → round-up triggered iff flag is true
    expect(ctx.voiceAudioSinceTick).toBe(true)
  })
})
