import {
  FinishReason,
  type Content,
  type FunctionCall,
  type GoogleGenAI
} from '@google/genai'
import type { AiSession } from '../aiClient'
import { executeFunctionByName } from '../aiToolAdapter'
import { ALL_TOOL_DECLARATIONS, TOOL_SCHEMAS, webSearch } from './functionTools'
import {
  newStreamState,
  processChunk,
  type StreamStatusPhase
} from './streamStatus'

/**
 * The agentic loop: call Gemini with streaming + function calling, dispatch
 * any client-side tool invocations, loop until the model emits a plain text
 * response (no function calls) or we hit a stop condition.
 *
 * Contract:
 *   - Returns normally on `finishReason === STOP` with no function calls.
 *   - Throws on abort — caller distinguishes abort vs real error via
 *     `abortController.signal.aborted` in its own catch block.
 *   - Emits `setStatus(...)` at every state transition.
 *
 * Unlike the Anthropic version, Gemini has no `pause_turn` / `container`
 * machinery. The loop is structurally simpler: each turn either wants tools
 * (functionCalls present) or is terminal.
 */

const MAX_TURNS = 20

export interface RunLoopOptions {
  ai: GoogleGenAI
  model: string
  systemPrompt: string
  initialPrompt: string
  aiSession: AiSession
  sessionId: string
  abortController: AbortController
  setStatus: (phase: StreamStatusPhase, message?: string) => void
  /** Optional logger — defaults to `console.log` tagged with the session id. */
  logger?: (msg: string) => void
}

export async function runAgenticLoop(opts: RunLoopOptions): Promise<void> {
  const {
    ai, model, systemPrompt, initialPrompt,
    aiSession, sessionId, abortController, setStatus
  } = opts
  const log = opts.logger ?? ((msg: string) => console.log(`[ai/prompt ${sessionId}] ${msg}`))

  // Manual `contents` history. Each turn:
  //   - push `{ role: 'model', parts: [...] }` with whatever the model returned
  //   - push `{ role: 'user', parts: [functionResponse, ...] }` with our tool results
  const contents: Content[] = [
    { role: 'user', parts: [{ text: initialPrompt }] }
  ]

  let turns = 0

  while (turns < MAX_TURNS) {
    if (abortController.signal.aborted) throw new Error('aborted')
    turns += 1

    setStatus('thinking', 'Thinking…')
    log(`turn ${turns}: calling Gemini (${contents.length} messages)`)

    const stream = await ai.models.generateContentStream({
      model,
      contents,
      config: {
        systemInstruction: systemPrompt,
        tools: [{ functionDeclarations: ALL_TOOL_DECLARATIONS }],
        abortSignal: abortController.signal
      }
    })

    // Per-turn state: status dedupe + accumulation of the model's own reply so
    // we can append it to `contents` on continuation.
    const streamState = newStreamState()
    const modelParts: NonNullable<Content['parts']> = []
    const functionCalls: FunctionCall[] = []
    let finishReason: FinishReason | undefined

    for await (const chunk of stream) {
      if (abortController.signal.aborted) throw new Error('aborted')

      // Status announcements (derived from functionCalls in this chunk).
      processChunk(chunk, streamState, { setStatus, logger: log })

      // Accumulate model output so we can append it to `contents` verbatim
      // if the turn continues. Gemini splits one logical response across
      // multiple chunks; each chunk contributes parts for the same candidate.
      const parts = chunk.candidates?.[0]?.content?.parts
      if (parts) modelParts.push(...parts)

      const calls = chunk.functionCalls
      if (calls?.length) functionCalls.push(...calls)

      const reason = chunk.candidates?.[0]?.finishReason
      if (reason) finishReason = reason
    }

    log(`turn ${turns}: finishReason=${finishReason}, parts=${modelParts.length}, calls=${functionCalls.length}`)

    // Record the model's response so the next turn (if any) has full history.
    // Gemini requires the model's Content block to be present before the
    // corresponding functionResponse user block.
    contents.push({ role: 'model', parts: modelParts })

    // No function calls → natural end of conversation (plain text response).
    if (functionCalls.length === 0) {
      if (finishReason && finishReason !== FinishReason.STOP && finishReason !== FinishReason.MAX_TOKENS) {
        // Safety / recitation / malformed — surface as error.
        setStatus('error', `Stopped: ${finishReason}`)
      } else {
        setStatus('done', 'Done')
      }
      return
    }

    // Terminal non-STOP finishReasons we should still bail on, even if calls
    // were emitted (e.g. MALFORMED_FUNCTION_CALL means the args are junk).
    if (
      finishReason === FinishReason.MALFORMED_FUNCTION_CALL
      || finishReason === FinishReason.UNEXPECTED_TOOL_CALL
      || finishReason === FinishReason.SAFETY
      || finishReason === FinishReason.PROHIBITED_CONTENT
    ) {
      setStatus('error', `Stopped: ${finishReason}`)
      return
    }

    // Execute each function call in order; build a single user message whose
    // parts are the functionResponse entries (Gemini's continuation contract).
    const responseParts: NonNullable<Content['parts']> = []
    for (const call of functionCalls) {
      if (abortController.signal.aborted) throw new Error('aborted')
      if (!call.name) continue

      log(`function_call: ${call.name} args=${JSON.stringify(call.args).slice(0, 200)}`)

      // Validate args with the Zod schema registered for this tool. Gemini
      // *usually* returns args that match the declared schema, but not
      // guaranteed — malformed args used to silently coerce via defensive
      // `String()` / `Number()` casts. Now we surface them cleanly to the
      // model so it can retry with the correct shape.
      const schema = TOOL_SCHEMAS[call.name]
      let validatedArgs: unknown
      if (schema) {
        const parsed = schema.safeParse(call.args ?? {})
        if (!parsed.success) {
          const zodMsg = parsed.error.issues
            .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')
          log(`function_call validation failed: ${call.name}: ${zodMsg}`)
          responseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: {
                output: `Error: invalid arguments for ${call.name}: ${zodMsg}`,
                isError: true
              }
            }
          })
          continue
        }
        validatedArgs = parsed.data
      } else {
        // Unknown tool — let executeFunctionByName / webSearch branch handle
        // the "unsupported" error. Pass raw args through.
        validatedArgs = call.args ?? {}
      }

      let result: { content: string, isError: boolean }
      if (call.name === 'web_search') {
        // Safe cast — schema guarantees `{ query: string }`.
        const { query } = validatedArgs as { query: string }
        try {
          const text = await webSearch(ai, model, query, abortController.signal)
          result = { content: text, isError: false }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'Unknown error'
          if (abortController.signal.aborted) throw e
          result = { content: `Error: web_search failed: ${msg}`, isError: true }
        }
      } else {
        result = executeFunctionByName(aiSession, call.name, validatedArgs)
      }

      responseParts.push({
        functionResponse: {
          id: call.id,
          name: call.name,
          // Gemini's SDK expects a Record here. We wrap into `{ output, ... }`
          // so the model sees a consistent shape; include isError so it can
          // react (e.g. try a different old_str if replace_text failed).
          response: { output: result.content, isError: result.isError }
        }
      })
    }

    if (responseParts.length === 0) {
      // Shouldn't happen (we had functionCalls above) but guard against
      // a pathological case where all names were unset.
      log('no function responses to send; ending loop defensively')
      setStatus('done', 'Done')
      return
    }

    contents.push({ role: 'user', parts: responseParts })
  }

  // Ran out of turns.
  setStatus('error', 'Hit turn limit')
}
