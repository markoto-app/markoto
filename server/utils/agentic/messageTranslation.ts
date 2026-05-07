import type {
  AgenticContent as Content,
  AgenticFunctionDeclaration as FunctionDeclaration,
  AgenticPart as Part,
  AgenticGenerateContentResponse
} from './aiTypes'
import { AgenticFinishReason as FinishReason } from './aiTypes'
import type OpenAI from 'openai'

/**
 * Internal-shape ↔ OpenAI message-shape translator for the Phase 4
 * dual-mode agentic loop. The loop's internal representation stays in
 * the historical `Content[]` shape (pre-migration: Gemini-derived,
 * minimises the runLoop.ts rewrite); these helpers convert to/from
 * OpenAI's messages array at the LLM boundary.
 *
 * One-way translation guidance:
 *   - `Content[]` → `OpenAI messages[]` runs at every turn before calling
 *     LiteLLM. Includes the system prompt as a top message.
 *   - OpenAI streaming chunk → internal-shaped chunk runs inside a wrapped
 *     async iterator so the existing chunk-handler in runLoop.ts keeps
 *     working unchanged. The wrapper accumulates fragmented tool-call
 *     arguments and emits the complete `chunk.functionCalls` array on
 *     the final chunk.
 *
 * Vision-input mapping: the internal shape smuggles binary parts
 * (`view_image` / `view_pages`) as `extraParts` *after* the
 * `functionResponse` on the same user message. OpenAI/Mistral expect
 * images as `image_url` parts on a user message instead. The
 * translator detects the smuggling pattern (a `functionResponse` part
 * followed by `inlineData` parts in the same `user` message) and
 * rewrites: the function response becomes a `tool` message (matched by
 * `tool_call_id`); a *separate* user message immediately after carries
 * the `image_url` parts, with a brief "Here is the image you
 * requested:" text so Mistral knows the image is the result of the
 * previous tool call.
 */

// ─── Outbound: internal Content[] → OpenAI messages[] ────────────────────

type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam
type OAIToolMessage = OpenAI.Chat.Completions.ChatCompletionToolMessageParam
type OAIUserContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart

// `Part` (= AgenticPart) is the single source of truth for content
// parts; importing here keeps the runLoop.ts ↔ messageTranslation.ts
// boundary structurally identical so spreading `chunk.candidates[0].
// content.parts` into a `Content['parts']` array typechecks.

/**
 * Translate the loop's internal `Content[]` into OpenAI's `messages[]`.
 *
 * Conversion rules:
 *   - System prompt → first message (`role: 'system'`)
 *   - `role: 'user'` with text-only parts → `role: 'user'` with string content
 *   - `role: 'user'` with `inlineData` (image bytes from a prior tool) →
 *     `role: 'user'` with multipart `[{type: 'text'}, {type: 'image_url'}]`
 *   - `role: 'user'` with `functionResponse` parts → one `role: 'tool'`
 *     message per response, matched by `tool_call_id`. Sibling
 *     `inlineData` parts (the historical "extraParts" smuggle pattern)
 *     split off into a fresh `role: 'user'` message right after, so the
 *     model ties the image to the function it just called.
 *   - `role: 'model'` with text + functionCall parts → `role: 'assistant'`
 *     with optional `content` and `tool_calls` array.
 */
export function internalToOpenAIMessages(
  systemPrompt: string,
  contents: Content[]
): OAIMessage[] {
  const messages: OAIMessage[] = [
    { role: 'system', content: systemPrompt }
  ]

  for (const block of contents) {
    const role = block.role
    const parts = (block.parts ?? []) as Part[]

    if (role === 'user') {
      // Split into (a) tool-response parts (each becomes a `tool` message)
      // (b) text + inlineData parts (combined into one user message).
      const toolResponses: Part[] = []
      const userParts: Part[] = []
      for (const p of parts) {
        if (p.functionResponse) toolResponses.push(p)
        else userParts.push(p)
      }

      // Tool messages first — OpenAI requires `tool` messages reference
      // a prior assistant tool_call id, which is satisfied because
      // contents.push(model) ran before contents.push(user{functionResponse}).
      for (const p of toolResponses) {
        const fr = p.functionResponse!
        const out = fr.response as { output?: unknown, isError?: boolean } | undefined
        const text = out !== undefined && typeof out === 'object'
          ? (typeof (out as { output?: unknown }).output === 'string'
              ? (out as { output: string }).output
              : JSON.stringify(out))
          : String(out ?? '')
        const toolMsg: OAIToolMessage = {
          role: 'tool',
          tool_call_id: fr.id ?? '',
          content: text
        }
        messages.push(toolMsg)
      }

      // Then the carrier user message (text + any image parts). When the
      // user block contained ONLY tool-responses + inlineData (the
      // common `view_image` smuggle), we emit a small synthetic preamble
      // so the model knows the images are the result of the prior tool.
      const hasImages = userParts.some(p => p.inlineData?.data)
      const hasText = userParts.some(p => p.text && p.text.length > 0)

      if (hasImages || hasText) {
        if (hasImages) {
          const contentParts: OAIUserContentPart[] = []
          // Prepend a brief text frame so the model has context for
          // why the images are present (especially when the user
          // block carries no other text — i.e. it was wholly the
          // smuggle pattern).
          const textBlobs = userParts
            .map(p => p.text ?? '')
            .filter(Boolean)
            .join(' ')
            .trim()
          contentParts.push({
            type: 'text',
            text: textBlobs.length > 0
              ? textBlobs
              : 'Here is the image you requested.'
          })
          for (const p of userParts) {
            if (p.inlineData?.data) {
              const mime = p.inlineData.mimeType ?? 'image/png'
              contentParts.push({
                type: 'image_url',
                image_url: { url: `data:${mime};base64,${p.inlineData.data}` }
              })
            }
          }
          messages.push({ role: 'user', content: contentParts })
        } else {
          // Pure-text user message
          const text = userParts.map(p => p.text ?? '').filter(Boolean).join('').trim()
          if (text.length > 0) {
            messages.push({ role: 'user', content: text })
          }
        }
      }
    } else if (role === 'model') {
      const textBuf: string[] = []
      const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = []
      for (const p of parts) {
        if (p.text && p.text.length > 0) textBuf.push(p.text)
        if (p.functionCall) {
          toolCalls.push({
            id: p.functionCall.id ?? '',
            type: 'function',
            function: {
              name: p.functionCall.name ?? '',
              arguments: JSON.stringify(p.functionCall.args ?? {})
            }
          })
        }
      }
      const text = textBuf.join('')
      const assistantMsg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        // OpenAI expects content to be either string or null when tool_calls
        // are present.
        content: text.length > 0 ? text : null
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      messages.push(assistantMsg)
    }
  }

  return messages
}

// ─── Tool declarations: internal → OpenAI ───────────────────────────────

/**
 * Translate internal `FunctionDeclaration[]` into OpenAI's `tools[]`. The
 * underlying parameter schemas are JSON-Schema (Zod produces draft-7
 * via `z.toJSONSchema`), which both providers accept verbatim.
 */
export function internalToOpenAITools(
  toolDeclarations: FunctionDeclaration[]
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return toolDeclarations.map(d => ({
    type: 'function' as const,
    function: {
      name: d.name ?? '',
      description: d.description ?? '',
      // The parameters object is already a JSON-Schema-shaped record;
      // the OpenAI SDK accepts `Record<string, unknown>` here.
      parameters: (d.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>
    }
  }))
}

// ─── Inbound: OpenAI streaming chunks → internal-shaped chunks ──────────

/**
 * Wrap an OpenAI streaming chunk iterator so the consumer (existing
 * runLoop.ts code) sees internal-shaped chunks. This lets the existing
 * chunk-handling code stay unchanged: it reads
 * `chunk.candidates[0].content.parts`, `chunk.functionCalls`, and
 * `chunk.usageMetadata` (shape pre-migration: Gemini-derived).
 *
 * Streaming tool-call accumulator: Mistral's chat-completions stream
 * delivers `delta.tool_calls[].function.arguments` as fragmented JSON
 * across chunks, indexed by `tool_calls[].index`. We accumulate per
 * index, finalize on the chunk that reports `finish_reason: 'tool_calls'`
 * (or end of stream), and synthesize an internal-shape chunk carrying
 * the complete `functionCalls` array.
 *
 * We yield TWO kinds of synthetic internal chunks:
 *   1. Per-text-delta chunk: `{ candidates: [{ content: { parts: [{text}] } }] }`
 *      — drives status updates + the pure-prose-salvage path.
 *   2. Terminal chunk: emits accumulated `functionCalls` + `finishReason`
 *      + `usageMetadata`. Triggered on stream end.
 *
 * This is intentionally a thin shim. It does NOT validate or dispatch
 * tool calls — that's the existing runLoop.ts loop body's job.
 */

interface AccumulatingToolCall {
  id: string
  name: string
  argsBuffer: string
}

// Streaming chunk shape — re-exported alias for callers (runLoop.ts)
// that previously imported `GeminiStreamChunk` from here. Identical
// shape; the rename collapses two duplicate interfaces.
export type StreamChunk = AgenticGenerateContentResponse

/**
 * Wrap an OpenAI streaming response and yield internal-shape chunks.
 * The wrapper consumes the OpenAI stream once.
 */
export async function* openAIStreamToInternalChunks(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
): AsyncGenerator<StreamChunk, void, unknown> {
  const accum = new Map<number, AccumulatingToolCall>()
  let finishReason: string | undefined
  let promptTokens: number | undefined
  let completionTokens: number | undefined

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta | undefined

    // Text content delta → internal-shape text chunk (drives status, prose-salvage)
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      yield {
        candidates: [{
          content: { role: 'model', parts: [{ text: delta.content }] }
        }]
      }
    }

    // Tool-call deltas. Each delta entry has an `index` we accumulate by.
    // First chunk for an index typically carries id + name; subsequent
    // chunks append fragments to function.arguments.
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        const existing = accum.get(idx)
        if (!existing) {
          accum.set(idx, {
            id: tc.id ?? '',
            name: tc.function?.name ?? '',
            argsBuffer: tc.function?.arguments ?? ''
          })
        } else {
          if (tc.id) existing.id = tc.id
          if (tc.function?.name) existing.name = tc.function.name
          if (tc.function?.arguments) existing.argsBuffer += tc.function.arguments
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason

    // Usage often arrives on the FINAL chunk (or via `stream_options:
    // {include_usage: true}`). Mistral provides it in the last chunk.
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens
      completionTokens = chunk.usage.completion_tokens
    }
  }

  // Terminal: synthesize final chunk with parts + functionCalls + usage.
  const calls: NonNullable<StreamChunk['functionCalls']> = []
  const modelParts: Part[] = []
  for (const [, t] of accum) {
    let parsedArgs: Record<string, unknown> = {}
    if (t.argsBuffer && t.argsBuffer.trim().length > 0) {
      try {
        parsedArgs = JSON.parse(t.argsBuffer)
      } catch {
        // Corrupt args — surface as empty so the loop's Zod validation
        // catches it as a malformed call. The model can retry.
        parsedArgs = {}
      }
    }
    calls.push({ id: t.id, name: t.name, args: parsedArgs })
    modelParts.push({
      functionCall: { id: t.id, name: t.name, args: parsedArgs }
    })
  }

  yield {
    candidates: [{
      content: { role: 'model', parts: modelParts },
      finishReason: mapFinishReason(finishReason)
    }],
    functionCalls: calls.length > 0 ? calls : undefined,
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: completionTokens,
      thoughtsTokenCount: undefined
    }
  }
}

/**
 * OpenAI's `finish_reason` values → the internal `FinishReason` enum
 * (pre-migration: Gemini-derived). Anything we don't explicitly map
 * falls through to `OTHER` so the existing exit-path code recognises
 * it as terminal-but-unusual.
 */
function mapFinishReason(reason: string | undefined): FinishReason | undefined {
  if (!reason) return undefined
  switch (reason) {
    case 'stop': return FinishReason.STOP
    case 'length': return FinishReason.MAX_TOKENS
    case 'tool_calls': return FinishReason.STOP // Tool calls = the loop continues
    case 'content_filter': return FinishReason.SAFETY
    default: return FinishReason.OTHER
  }
}
