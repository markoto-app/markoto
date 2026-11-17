import { describe, expect, it, vi } from 'vitest'
import { litellmCompletion, litellmStream } from '../../../server/utils/litellm/createCompletion'

// LiteLLM's body extensions (spend tags, clientside BYOK credentials) don't
// fit the OpenAI SDK's param types. The wrapper hands the SDK the standard
// fields as typed params and the full body through the `body` request
// option, which the SDK sends instead of its own serialisation.

describe('LiteLLM body extensions', () => {
  const body = {
    model: 'byok/chat',
    messages: [{ role: 'user' as const, content: 'hi' }],
    metadata: { tags: ['feature:chat', 'plan:free'] },
    api_key: 'sk-user',
    api_base: 'https://provider.example/v1'
  }

  it('sends the full body (tags, credentials) and gives the SDK only the OpenAI fields', async () => {
    const create = vi.fn(async () => ({ choices: [] }))
    const client = { chat: { completions: { create } } }
    await litellmCompletion(client as never, body)
    expect(create).toHaveBeenCalledWith(
      { model: 'byok/chat', messages: body.messages },
      { signal: undefined, body }
    )
  })

  it('passes maxRetries to the SDK only when the caller sets it (paid image calls send 0)', async () => {
    const create = vi.fn(async () => ({ choices: [] }))
    const client = { chat: { completions: { create } } }
    await litellmCompletion(client as never, body, { maxRetries: 0 })
    expect(create).toHaveBeenCalledWith(
      { model: 'byok/chat', messages: body.messages },
      { signal: undefined, body, maxRetries: 0 }
    )
  })

  it('does the same for a streamed completion', async () => {
    const create = vi.fn(async () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }))
    const client = { chat: { completions: { create } } }
    await litellmStream(client as never, { ...body, stream: true })
    expect(create).toHaveBeenCalledWith(
      { model: 'byok/chat', messages: body.messages, stream: true },
      { signal: undefined, body: { ...body, stream: true } }
    )
  })
})
