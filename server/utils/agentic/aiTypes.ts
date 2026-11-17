// Internal shapes for the agentic loop, independent of any vendor SDK.
// The runtime path is OpenAI-shape via LiteLLM (translated by
// `messageTranslation.ts`), but the loop's internal representation is a
// `{role, parts}` shape because tools naturally produce and consume parts.

/**
 * Single content part. Mirrors the model's Part union, at most one
 * field on a given part is populated. Translation to OpenAI shape
 * fans these out into `text` / `image_url` / `tool_calls` /
 * `tool_response` blocks.
 */
export interface AgenticPart {
  text?: string
  inlineData?: { mimeType?: string, data?: string }
  /**
   * `rawArgs`: the argument JSON exactly as the model streamed it. Replayed
   * verbatim in later turns (instead of re-serialising `args`) so the
   * history stays byte-identical to what the provider generated, the
   * prompt-cache prefix must not change between turns.
   */
  functionCall?: { id?: string, name?: string, args?: unknown, rawArgs?: string }
  functionResponse?: {
    id?: string
    name?: string
    response?: { output?: string, isError?: boolean } | Record<string, unknown>
  }
  // Reserved for future grounding metadata. The current loop doesn't
  // read this; kept on the type so optional spread doesn't drop fields.
  thought?: boolean
}

/**
 * One turn of the agentic conversation. `role` is `'user'` for both
 * the human prompt + tool-result responses, and `'model'` for the
 * AI's emitted text/function-calls.
 */
export interface AgenticContent {
  // Forward-compat: known values are 'user' / 'model'; the wider
  // `string` accepts upstream additions without forcing a type bump.
  role?: string
  parts?: AgenticPart[]
}

/**
 * Tool declaration shape. JSONSchema parameters are passed verbatim
 * through to the model; the tool registry (`ai/tools/`) builds these
 * from Zod schemas via `z.toJSONSchema`.
 */
export interface AgenticFunctionDeclaration {
  name?: string
  description?: string
  parameters?: {
    // JSON Schema allows `type` to be a single type name or an array of
    // them; zod's `toJSONSchema` result is typed that way (zod ≥ 4.4).
    type?: string | string[]
    properties?: Record<string, unknown>
    required?: string[]
    [k: string]: unknown
  }
}

/**
 * A single function-call request emitted by the model. `args` is
 * raw: the loop validates it against the matching tool's Zod
 * schema before invoking the handler.
 */
export interface AgenticFunctionCall {
  id?: string
  name?: string
  args?: unknown
  /**
   * The streamed argument text was not a JSON object (cut off by the output
   * token limit, or malformed). `args` is then `{}`; the loop answers the
   * call with an error instead of validating it.
   */
  argsInvalid?: boolean
}

/**
 * Reasons the model can give for ending a turn. The loop reads
 * `STOP` to mean "done"; everything else triggers a continuation
 * or surfaces an error to the user.
 */
export const AgenticFinishReason = {
  STOP: 'STOP',
  MAX_TOKENS: 'MAX_TOKENS',
  SAFETY: 'SAFETY',
  RECITATION: 'RECITATION',
  LANGUAGE: 'LANGUAGE',
  OTHER: 'OTHER',
  BLOCKLIST: 'BLOCKLIST',
  PROHIBITED_CONTENT: 'PROHIBITED_CONTENT',
  SPII: 'SPII',
  MALFORMED_FUNCTION_CALL: 'MALFORMED_FUNCTION_CALL',
  UNEXPECTED_TOOL_CALL: 'UNEXPECTED_TOOL_CALL'
} as const
export type AgenticFinishReason = typeof AgenticFinishReason[keyof typeof AgenticFinishReason]

/**
 * Streaming response chunk. The loop assembles these into the next
 * `Content` to push onto the conversation history.
 */
export interface AgenticGenerateContentResponse {
  functionCalls?: AgenticFunctionCall[]
  text?: string
  candidates?: Array<{
    // `role` is `'model'` for assistant turns and absent for the
    // synthetic test chunks. Optional so the test seam (which yields
    // bare `{candidates:[{content:{parts:[...]}}]}` shapes) keeps
    // typechecking without per-test fix-up.
    content?: { role?: string, parts?: AgenticPart[] }
    // Known values come from `AgenticFinishReason`; the wider `string`
    // accepts upstream additions like 'tool_calls' / 'eos' without
    // forcing this union to drift.
    finishReason?: string
  }>
  /** Model the provider reported in the response (OpenAI `model`), when it named one. */
  modelVersion?: string
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    /** Prompt tokens served from the provider's prompt cache (`usage.prompt_tokens_details.cached_tokens`). */
    cachedContentTokenCount?: number
  }
}

/**
 * Minimal AI-client shape the loop's test seam consumes. Production
 * goes through `streamFromLiteLLM` and never calls this surface;
 * unit tests inject a fake whose `models.generateContentStream`
 * yields scripted chunks. Kept tight on purpose, anything more
 * elaborate would invite drift from the LiteLLM path.
 */
export interface AgenticAIClient {
  models: {
    generateContentStream: (args: {
      model: string
      contents: AgenticContent[]
      config?: {
        systemInstruction?: string
        tools?: Array<{ functionDeclarations?: AgenticFunctionDeclaration[] }>
        abortSignal?: AbortSignal
        thinkingConfig?: { thinkingBudget?: number }
        /** Force a call to this function (`tool_choice`); unset = the model chooses. */
        forceFunction?: string
      }
    }) => Promise<AsyncIterable<AgenticGenerateContentResponse>>
  }
}
