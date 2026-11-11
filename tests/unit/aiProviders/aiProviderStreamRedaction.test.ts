import { describe, it, expect } from 'vitest'
import { AiProviderCallError, redactProviderStream } from '../../../server/utils/aiProviders/requestFields'
import type { ResolvedAiProvider } from '../../../server/utils/aiProviders/resolve'

// A8: a BYOK provider error raised WHILE the chat stream is consumed (an
// SSE error event, a dropped connection) must get the same key redaction
// as an error raised while opening the stream — the message reaches the
// initiator's status, the server log and Sentry.

const KEY = 'sk-user-secret-0123456789abcdef'

const byok: ResolvedAiProvider = {
  capability: 'chat',
  source: 'user',
  model: 'fake-chat',
  credentials: { baseUrl: 'https://provider.example/v1', apiKey: KEY },
  supportsVision: false
}
const alias: ResolvedAiProvider = { ...byok, source: 'instance', credentials: null }

async function* failingStream(message: string): AsyncGenerator<number> {
  yield 1
  yield 2
  throw new Error(message)
}

async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}

describe('redactProviderStream', () => {
  it('passes items through unchanged', async () => {
    async function* ok() {
      yield 'a'
      yield 'b'
    }
    expect(await drain(redactProviderStream(byok, ok()))).toEqual(['a', 'b'])
  })

  it('redacts the key from a mid-stream error', async () => {
    const seen: number[] = []
    let caught: unknown = null
    try {
      for await (const v of redactProviderStream(byok, failingStream(`upstream said: invalid key ${KEY} for org`))) seen.push(v)
    } catch (e) {
      caught = e
    }
    expect(seen).toEqual([1, 2])
    expect(caught).toBeInstanceOf(AiProviderCallError)
    const message = caught instanceof Error ? caught.message : ''
    expect(message).not.toContain(KEY)
    expect(message).not.toContain(KEY.slice(0, 12))
    expect(message).toContain('upstream said')
  })

  it('leaves platform-alias errors alone (no user key to redact)', async () => {
    await expect(drain(redactProviderStream(alias, failingStream('alias broke')))).rejects.toThrow('alias broke')
  })
})
