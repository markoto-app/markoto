// Internal shapes for the agentic loop. Phase 5 split: previously
// imported from `@google/genai`, now hand-rolled so the loop has a
// single source of truth that doesn't depend on a vendor SDK we
// no longer talk to. The runtime path is OpenAI-shape via LiteLLM
// (translated by `messageTranslation.ts`), but the loop's internal
// representation stays in the historical `{role, parts}` shape
// (pre-migration: Gemini) because (a) tools naturally produce +
// consume parts, and (b) it keeps the diff against the historic
// loop minimal.
//
// The `*Original` aliases at the bottom let migrating callers move
// import-by-import without an atomic rename.

/**
 * Single content part. Mirrors the model's Part union — at most one
 * field on a given part is populated. Translation to OpenAI shape
 * fans these out into `text` / `image_url` / `tool_calls` /
 * `tool_response` blocks.
 */
export interface AgenticPart {
  text?: string
  inlineData?: { mimeType?: string, data?: string }
  functionCall?: { id?: string, name?: string, args?: unknown }
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
  role?: 'user' | 'model' | string
  parts?: AgenticPart[]
}

/**
 * Tool declaration shape. JSONSchema parameters are passed verbatim
 * through to the model; `functionTools.ts` builds these from Zod
 * schemas via `z.toJSONSchema`.
 */
export interface AgenticFunctionDeclaration {
  name?: string
  description?: string
  parameters?: {
    type?: string
    properties?: Record<string, unknown>
    required?: string[]
    [k: string]: unknown
  }
}

/**
 * A single function-call request emitted by the model. `args` is
 * raw — the loop validates it against the matching tool's Zod
 * schema before invoking the handler.
 */
export interface AgenticFunctionCall {
  id?: string
  name?: string
  args?: unknown
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
    finishReason?: AgenticFinishReason | string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
  }
}

/**
 * Minimal AI-client shape the loop's test seam consumes. Production
 * goes through `streamFromLiteLLM` and never calls this surface;
 * unit tests inject a fake whose `models.generateContentStream`
 * yields scripted chunks. Kept tight on purpose — anything more
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
      }
    }) => Promise<AsyncIterable<AgenticGenerateContentResponse>>
  }
}
