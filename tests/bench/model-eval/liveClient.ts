import OpenAI from 'openai'
import type { AgenticAIClient, AgenticGenerateContentResponse } from '../../../server/utils/agentic/aiTypes'
import { internalToOpenAIMessages, internalToOpenAITools, openAIStreamToInternalChunks } from '../../../server/utils/agentic/messageTranslation'
import { assertBudget, costUsd, recordSpend, type CallUsage } from './pricing'

// A live AgenticAIClient for the eval: the same request the production path
// (`streamFromLiteLLM`, loop/providerStream.ts) builds, sent to a LOCAL
// LiteLLM (model-eval-data/scripts/litellm-eval.yaml) that forwards to
// Mistral's EU endpoint. Records usage and timing per call.

export const LITELLM_URL = process.env.EVAL_LITELLM_URL ?? 'http://127.0.0.1:4400/v1'
export const LITELLM_KEY = process.env.EVAL_LITELLM_KEY ?? 'sk-eval-local'

export interface CallRecord extends CallUsage {
  call: number
  usd: number
  /** ms from request start to the first streamed chunk with content or a tool-call delta. */
  ttftMs: number
  totalMs: number
  /** epoch ms when the call ended. */
  endedAt: number
  toolCalls: number
  finish: string | null
  error?: string
}

export function openaiClient(): OpenAI {
  return new OpenAI({ baseURL: LITELLM_URL, apiKey: LITELLM_KEY, maxRetries: 6, timeout: 300_000 })
}

export function makeLiveClient(model: string, experiment: string, calls: CallRecord[], cacheKey: string): AgenticAIClient {
  const client = openaiClient()
  return {
    models: {
      generateContentStream: async (args) => {
        assertBudget()
        const messages = internalToOpenAIMessages(args.config?.systemInstruction ?? '', args.contents)
        const tools = internalToOpenAITools(args.config?.tools?.[0]?.functionDeclarations ?? [])
        const started = Date.now()
        const cacheField: Record<string, unknown> = { prompt_cache_key: cacheKey }
        const raw = await client.chat.completions.create({
          model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: tools.length > 0 ? 'auto' : undefined,
          stream: true,
          stream_options: { include_usage: true },
          temperature: 0,
          // Same as the production loop: groups the turns of one document.
          ...cacheField
        }, { signal: args.config?.abortSignal })
        const record: CallRecord = { call: calls.length + 1, prompt: 0, cached: 0, output: 0, reasoning: 0, usd: 0, ttftMs: -1, totalMs: 0, endedAt: 0, toolCalls: 0, finish: null }
        calls.push(record)
        async function* tapped(): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk> {
          for await (const chunk of raw) {
            const delta = chunk.choices?.[0]?.delta as (Record<string, unknown> | undefined)
            if (record.ttftMs < 0 && delta && (delta.content || delta.tool_calls || delta.reasoning_content)) record.ttftMs = Date.now() - started
            if (chunk.choices?.[0]?.finish_reason) record.finish = chunk.choices[0].finish_reason
            if (chunk.usage) {
              record.prompt = chunk.usage.prompt_tokens ?? 0
              record.output = chunk.usage.completion_tokens ?? 0
              record.cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
              record.reasoning = chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0
            }
            yield chunk
          }
          record.totalMs = Date.now() - started
          record.endedAt = Date.now()
          record.usd = costUsd(model, record)
          recordSpend({ experiment, model, usage: { prompt: record.prompt, cached: record.cached, output: record.output, reasoning: record.reasoning }, usd: record.usd })
        }
        async function* counted(): AsyncGenerator<AgenticGenerateContentResponse> {
          for await (const c of openAIStreamToInternalChunks(tapped())) {
            if (c.functionCalls) record.toolCalls += c.functionCalls.length
            yield c
          }
        }
        return counted()
      }
    }
  }
}
