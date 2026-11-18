import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { litellmCompletion, litellmStream } from '../../../server/utils/litellm/createCompletion'

// Pin the 429-retry contract for the LiteLLM wrapper. Real flow tests
// (`tests/e2e/flows/ai-fetch-url.spec.ts`, `ai-generate-image.spec.ts`)
// fail with `429 RateLimitError` from Mistral's free tier when the test
// stack bursts AI calls. This wrapper retries transparently so:
//   1. Production users don't see "Could not reach markoto" on transient
//      throttles
//   2. Flow tests stop flaking on the same condition
//
// What the wrapper MUST do:
//   - Retry on 429 (up to 3 times after the initial attempt)
//   - Honor `Retry-After` header in seconds when present
//   - Use exponential backoff (1s, 2s, 4s) when no Retry-After hint
//   - NEVER retry budget_exceeded (it's correctness, surface to user)
//   - Pass through every other error on the first attempt
//   - Respect AbortSignal: cancel in-flight backoff
//
// We mock the OpenAI client at the call boundary; the test asserts on
// retry COUNT and TIMING (using fake timers to keep the suite fast).

interface MockOpenAIClient {
  chat: { completions: { create: ReturnType<typeof vi.fn> } }
}

function createClient(impls: Array<() => unknown>): MockOpenAIClient {
  const create = vi.fn()
  for (const impl of impls) {
    create.mockImplementationOnce(async () => {
      const r = impl()
      if (r instanceof Error) throw r
      return r
    })
  }
  return { chat: { completions: { create } } }
}

class RateLimitError extends Error {
  status = 429
  constructor(public headers: Record<string, string> = {}) {
    super('429 Rate limit exceeded')
  }
}

class BudgetExceeded extends Error {
  status = 400
  constructor() {
    super('budget_exceeded: this user has exceeded their max_budget')
  }
}

class GenericError extends Error {
  status = 500
}

describe('litellmCompletion: 429 retry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the response on first success (no retry)', async () => {
    const client = createClient([() => ({ id: 'ok' })])
    const p = litellmCompletion(
      client as never,
      { model: 'm', messages: [], stream: false }
    )
    await expect(p).resolves.toEqual({ id: 'ok' })
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1)
  })

  it('retries once on 429, succeeds on second attempt', async () => {
    const client = createClient([
      () => new RateLimitError(),
      () => ({ id: 'ok-after-retry' })
    ])
    const p = litellmCompletion(
      client as never,
      { model: 'm', messages: [], stream: false }
    )
    // Base backoff after first attempt: 3s.
    await vi.advanceTimersByTimeAsync(3000)
    await expect(p).resolves.toEqual({ id: 'ok-after-retry' })
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2)
  })

  it('exhausts after 4 retries (5 total attempts) and rethrows the last 429', async () => {
    const client = createClient([
      () => new RateLimitError(),
      () => new RateLimitError(),
      () => new RateLimitError(),
      () => new RateLimitError(),
      () => new RateLimitError()
    ])
    const p = litellmCompletion(
      client as never,
      { model: 'm', messages: [], stream: false }
    )
    // Expected backoffs: 3s, 6s, 12s, 24s, total 45s.
    // Attach the rejection handler before the timers run so the rejection is never unhandled.
    const outcome = p.then(() => null, (e: unknown) => e)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(await outcome).toEqual(expect.objectContaining({ message: expect.stringMatching(/Rate limit/) }))
    expect(client.chat.completions.create).toHaveBeenCalledTimes(5)
  })

  it('honors Retry-After header (seconds) instead of exponential backoff', async () => {
    const client = createClient([
      () => new RateLimitError({ 'retry-after': '7' }),
      () => ({ id: 'ok' })
    ])
    const p = litellmCompletion(
      client as never,
      { model: 'm', messages: [], stream: false }
    )
    // Server says wait 7s, 3s base would not be enough.
    await vi.advanceTimersByTimeAsync(3000)
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4000)
    await expect(p).resolves.toEqual({ id: 'ok' })
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry budget_exceeded (correctness signal)', async () => {
    const client = createClient([() => new BudgetExceeded()])
    const p = litellmCompletion(
      client as never,
      { model: 'm', messages: [], stream: false }
    )
    await expect(p).rejects.toThrow(/budget_exceeded/)
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry non-429 errors', async () => {
    const client = createClient([() => new GenericError('500 boom')])
    const p = litellmCompletion(
      client as never,
      { model: 'm', messages: [], stream: false }
    )
    await expect(p).rejects.toThrow(/500/)
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1)
  })

  it('aborts in-flight backoff when signal is triggered', async () => {
    const ac = new AbortController()
    const client = createClient([
      () => new RateLimitError(),
      () => ({ id: 'never-reached' })
    ])
    const p = litellmCompletion(
      client as never,
      { model: 'm', messages: [], stream: false },
      { signal: ac.signal }
    )
    // Trigger abort during the 3s backoff window.
    await vi.advanceTimersByTimeAsync(100)
    ac.abort()
    await expect(p).rejects.toThrow(/aborted/)
    // Only the first attempt happened, abort short-circuited the retry.
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1)
  })
})

describe('litellmStream: 429 retry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries on synchronous 429 before the stream begins', async () => {
    const fakeStream = (async function* () {
      yield { id: 'chunk-1' }
    })()
    const client = createClient([
      () => new RateLimitError(),
      () => fakeStream
    ])
    const p = litellmStream(
      client as never,
      { model: 'm', messages: [], stream: true }
    )
    await vi.advanceTimersByTimeAsync(3000)
    const stream = await p
    expect(stream).toBe(fakeStream)
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2)
  })
})

describe('litellmStream: callerRetries', () => {
  it('neither retries a 429 itself nor lets the SDK retry', async () => {
    const client = createClient([() => new RateLimitError()])
    await expect(litellmStream(client as never, { model: 'm', messages: [], stream: true }, { callerRetries: true })).rejects.toThrow('429')
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1)
    expect(client.chat.completions.create.mock.calls[0]?.[1]).toMatchObject({ maxRetries: 0 })
  })
})
