import type OpenAI from 'openai'

// Typed wrapper around `litellm.chat.completions.create(...)` that handles
// the cast for LiteLLM's `metadata.tags: string[]` extension.
//
// The OpenAI SDK types `ChatCompletionCreateParams['metadata']` as `Metadata`
// (= `Record<string, string>`). LiteLLM extends this with `{ tags: string[] }`
// for spend-attribution tags — structurally incompatible with the base type.
// Without a typed wrapper, every call site ended up writing
// `{...} as unknown as Parameters<typeof litellm.chat.completions.create>[0]`
// — a double cast that hides not just the metadata mismatch but ALL type
// errors in the body. These helpers narrow the cast to the metadata field
// alone; everything else stays type-checked.

export type LitellmCreateNonStreamParams = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  'metadata'
> & {
  metadata?: { tags: string[] }
}

export type LitellmCreateStreamParams = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
  'metadata'
> & {
  metadata?: { tags: string[] }
}

/**
 * Non-streaming chat completion through LiteLLM. Use when you need the
 * full response in one shot — e.g. `web_search` / `fetch_url` synthesis,
 * voice transcribe, voice-tick billing.
 */
export async function litellmCompletion(
  client: OpenAI,
  body: LitellmCreateNonStreamParams,
  opts?: { signal?: AbortSignal }
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  return (await client.chat.completions.create(
    body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    opts
  )) as OpenAI.Chat.Completions.ChatCompletion
}

/**
 * Streaming chat completion through LiteLLM. Use for the agentic loop's
 * main turn-by-turn streaming where we read tool-call deltas as they
 * arrive. Returns an `AsyncIterable<ChatCompletionChunk>` instead of the
 * SDK's `Stream<...>` — the chunk-translator in `messageTranslation.ts`
 * only consumes the iterator interface.
 */
export async function litellmStream(
  client: OpenAI,
  body: LitellmCreateStreamParams,
  opts?: { signal?: AbortSignal }
): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
  return (await client.chat.completions.create(
    body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
    opts
  )) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
}
