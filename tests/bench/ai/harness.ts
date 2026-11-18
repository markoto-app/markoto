import * as Y from 'yjs'
import {
  AgenticFinishReason as FinishReason,
  type AgenticContent as Content,
  type AgenticFunctionDeclaration as FunctionDeclaration,
  type AgenticGenerateContentResponse as GenerateContentResponse
} from '../../../server/utils/agentic/aiTypes'
import { internalToOpenAIMessages, internalToOpenAITools } from '../../../server/utils/agentic/messageTranslation'
import type { runAgenticLoop } from '../../../server/utils/agentic/runLoop'
import type { AiSession } from '../../../server/utils/ai/aiClient'
import type { ResolvedAiProviders } from '../../../server/utils/aiProviders/resolve'
import { soloSessionGuard } from '../../unit/fixtures/crossBoundary'
import { docAs } from '../../helpers/access'
import { partial } from '../../helpers/fixtures'
import type { WorkerUsage } from './jobModel'

// Scripted-planner benchmark harness. The REAL `runAgenticLoop` runs with a
// fake model client whose turns come from a per-task script, and the real tool
// handlers act on a real Y.Doc. Every request the loop sends is measured
// (system prompt + tool declarations + conversation), so a task's cost is what
// the loop's history handling makes of a competent model's tool calls, not a
// guess about the model.

type RunLoopOptions = Parameters<typeof runAgenticLoop>[0]
type AiClient = NonNullable<RunLoopOptions['ai']>

/**
 * German prose averages about 3.6 characters per token on the BPE tokenizers
 * of current chat models (GLM, Mistral; English is closer to 4). Applied to
 * every measured character: prose, JSON tool schemas, line-numbered tool
 * output. Raw characters are reported next to every token figure.
 */
export const CHARS_PER_TOKEN = 3.6

/**
 * Z.ai GLM-5.3 Flash on Mistral's EU endpoint, the hosted chat default, in
 * USD per million tokens (docs/AI-MODELS.md, model table: "$0.165 in / $0.55
 * out per M tokens, cached input $0.033").
 */
export const PRICE_USD_PER_M = { input: 0.165, cachedInput: 0.033, output: 0.55 } as const

/** Output speed for the time estimate. */
export const OUTPUT_TOKENS_PER_SECOND = 150
/** Fixed per-call latency (time to first token, tool dispatch) added per model call. */
export const PER_CALL_OVERHEAD_SECONDS = 1
/** `MAX_TURNS` in server/utils/agentic/runLoop.ts. */
export const MAX_TURNS = 20
/** `AI_SESSION_HARD_DEADLINE_MS` (server/utils/agentic/sessions/sessionSetup.ts), 5 minutes. */
export const SESSION_DEADLINE_SECONDS = 300

const HOSTED_WORKER = { capability: 'chat', source: 'instance', model: 'markoto-worker', credentials: null, supportsVision: false } as const

/** The hosted free tier's providers: GLM-5.3 Flash chat with vision, the Ministral worker, no image or transcription default. */
export const HOSTED_FREE_PROVIDERS: ResolvedAiProviders = {
  chat: { capability: 'chat', source: 'instance', model: 'zai-glm-5-3-flash', credentials: null, supportsVision: true },
  image: null,
  transcription: null,
  worker: { fast: HOSTED_WORKER, strong: HOSTED_WORKER, utility: HOSTED_WORKER }
}

export function tokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN)
}

// Script API

export interface ScriptCall {
  name: string
  args: Record<string, unknown>
}

export interface ToolOutcome {
  name: string
  output: string
  isError: boolean
}

/** What a task script sees: it plays the model, one `turn` per model call. */
export interface ScriptApi {
  /** One model turn emitting these tool calls; resolves with their results once the loop sends the next request. */
  turn(calls: ScriptCall[]): Promise<ToolOutcome[]>
  /** One model turn with a single tool call. */
  call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>
  /** The result of the most recent tool call. */
  readonly lastResult: ToolOutcome | null
  /** The live document text (what the edit results have shown the model so far). */
  docText(): string
  /** Record task progress (0..1) the NEXT turn reaches once its calls ran, e.g. the share of the document rewritten. */
  reportProgress(fraction: number): void
}

export type TaskScript = (api: ScriptApi) => Promise<void>

/** A benchmark task. The same `id` can be re-scripted for new tools under another `variant`. */
export interface BenchTask {
  id: string
  variant: string
  title: string
  /** The user's prompt, as typed into the prompt bar. */
  prompt: string
  script: TaskScript
  /** Checks the final document; returns a problem description, or null when the edit landed as intended. */
  verify?: (initial: string, final: string) => string | null
}

// Measurements

export interface RequestMeasure {
  /** 1-based model call index within the session. */
  call: number
  systemChars: number
  toolsChars: number
  conversationChars: number
  /** Characters of the tool calls the model emitted in this call (names + JSON arguments). */
  outputChars: number
  toolCalls: number
  /** Task progress once this call's tools ran (as reported by the script). */
  progress: number | null
}

export interface TaskResult {
  id: string
  variant: string
  title: string
  outcome: string
  modelCalls: number
  toolCalls: number
  toolErrors: number
  inputChars: number
  inputTokens: number
  /** Input tokens of the static prefix (system + tools), summed over calls: the cacheable part. */
  prefixTokens: number
  outputChars: number
  outputTokens: number
  costUncachedUsd: number
  costCachedUsd: number
  estSeconds: number
  withinTurnLimit: boolean
  withinDeadline: boolean
  feasible: boolean
  /** Progress at the end of the session (1 when the script finished). */
  progress: number
  /** Progress reached by the 5-minute deadline (estimated). */
  progressAtDeadline: number
  verifyProblem: string | null
  requests: RequestMeasure[]
  /** Delegated job (variant step8): the modelled worker calls, outside the planner session. */
  worker?: WorkerUsage
}

export interface StaticPrefix {
  systemPromptChars: number
  systemPromptTokens: number
  toolCount: number
  toolsChars: number
  toolsTokens: number
}

function messageChars(message: ReturnType<typeof internalToOpenAIMessages>[number]): number {
  let chars = 0
  const content = message.content
  if (typeof content === 'string') chars += content.length
  else if (Array.isArray(content)) {
    for (const part of content) {
      if ('text' in part && typeof part.text === 'string') chars += part.text.length
    }
  }
  if (message.role === 'assistant' && message.tool_calls) {
    for (const tc of message.tool_calls) {
      if (tc.type === 'function') chars += tc.function.name.length + tc.function.arguments.length
    }
  }
  return chars
}

export function toolsJsonChars(declarations: FunctionDeclaration[]): number {
  return JSON.stringify(internalToOpenAITools(declarations)).length
}

// The scripted model

type Action = { kind: 'calls', calls: ScriptCall[] } | { kind: 'stop' } | { kind: 'error', error: unknown }

type StreamArgs = Parameters<AiClient['models']['generateContentStream']>[0]

/** Parse the functionResponse parts the loop appended for the previous turn. */
function lastToolOutcomes(contents: Content[]): ToolOutcome[] {
  const last = contents[contents.length - 1]
  if (!last || last.role !== 'user') return []
  return (last.parts ?? []).flatMap((p) => {
    const fr = p.functionResponse
    if (!fr) return []
    const response = fr.response as { output?: unknown, isError?: unknown } | undefined
    return [{ name: fr.name ?? '', output: typeof response?.output === 'string' ? response.output : '', isError: response?.isError === true }]
  })
}

class ScriptedModel {
  readonly requests: RequestMeasure[] = []
  private readonly queue: Action[] = []
  private waiter: ((a: Action) => void) | null = null
  private pending: ((r: ToolOutcome[]) => void) | null = null
  private started = false
  private callSeq = 0
  private latestProgress: number | null = null
  lastResult: ToolOutcome | null = null

  private push(action: Action): void {
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w(action)
    } else {
      this.queue.push(action)
    }
  }

  private take(): Promise<Action> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve) => {
      this.waiter = resolve
    })
  }

  private readonly api: ScriptApi
  readonly ai: AiClient
  toolErrors = 0

  constructor(private readonly script: TaskScript, private readonly ytext: Y.Text) {
    const lastResult = (): ToolOutcome | null => this.lastResult
    const turn = (calls: ScriptCall[]): Promise<ToolOutcome[]> => new Promise<ToolOutcome[]>((resolve) => {
      this.pending = resolve
      this.push({ kind: 'calls', calls })
    })
    this.api = {
      turn,
      call: async (name, args) => {
        const [result] = await turn([{ name, args }])
        if (!result) throw new Error(`no result for ${name}`)
        return result
      },
      get lastResult() {
        return lastResult()
      },
      docText: () => this.ytext.toJSON(),
      reportProgress: (fraction) => {
        this.latestProgress = fraction
      }
    }
    this.ai = { models: { generateContentStream: async args => this.onRequest(args) } }
  }

  private async onRequest(args: StreamArgs): Promise<AsyncIterable<GenerateContentResponse>> {
    // Measure what the loop would send on the wire (OpenAI shape), now:
    // the loop keeps appending to `contents` after this call.
    const systemPrompt = args.config?.systemInstruction ?? ''
    const messages = internalToOpenAIMessages(systemPrompt, args.contents)
    const declarations = args.config?.tools?.[0]?.functionDeclarations ?? []
    const measure: RequestMeasure = {
      call: this.requests.length + 1,
      systemChars: systemPrompt.length,
      toolsChars: toolsJsonChars(declarations),
      conversationChars: messages.slice(1).reduce((sum, m) => sum + messageChars(m), 0),
      outputChars: 0,
      toolCalls: 0,
      progress: null
    }
    this.requests.push(measure)

    if (!this.started) {
      this.started = true
      this.script(this.api).then(
        () => this.push({ kind: 'stop' }),
        (error: unknown) => this.push({ kind: 'error', error })
      )
    } else if (this.pending) {
      const resolve = this.pending
      this.pending = null
      const outcomes = lastToolOutcomes(args.contents)
      this.lastResult = outcomes[outcomes.length - 1] ?? null
      this.toolErrors += outcomes.filter(o => o.isError).length
      resolve(outcomes)
    }

    const action = await this.take()
    measure.progress = this.latestProgress
    if (action.kind === 'error') throw action.error instanceof Error ? action.error : new Error(String(action.error))
    if (action.kind === 'stop') return chunks([{ candidates: [{ content: { role: 'model', parts: [] }, finishReason: FinishReason.STOP }] }])

    const functionCalls = action.calls.map((c) => {
      this.callSeq += 1
      return { id: `call_${this.callSeq}`, name: c.name, args: c.args }
    })
    const parts = functionCalls.map(fc => ({ functionCall: { ...fc, rawArgs: JSON.stringify(fc.args) } }))
    measure.toolCalls = functionCalls.length
    measure.outputChars = parts.reduce((sum, p) => sum + p.functionCall.name.length + p.functionCall.rawArgs.length, 0)
    return chunks([{ functionCalls, candidates: [{ content: { role: 'model', parts }, finishReason: FinishReason.STOP }] }])
  }
}

function chunks(list: GenerateContentResponse[]): AsyncIterable<GenerateContentResponse> {
  return {
    async* [Symbol.asyncIterator]() {
      for (const c of list) yield c
    }
  }
}

// Running a task

export interface RunTaskOptions {
  runAgenticLoop: typeof runAgenticLoop
  document: string
  systemPrompt: string
  /** Per-document blocks that open the first user message (`assemblePromptContext`). */
  promptContext: string
  /** Builds the first user message from the prompt (editor-state wrapping). */
  wrapPrompt: (prompt: string) => string
}

function makeSession(document: string, sessionId: string): { session: AiSession, ytext: Y.Text } {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  ytext.insert(0, document)
  const session = partial<AiSession>({
    ydoc,
    ytext,
    ymeta: ydoc.getMap('meta'),
    sessionId,
    docId: 'BenchHandbook01',
    initiatorUserId: 1,
    workspaceId: null,
    docAccess: docAs('BenchHandbook01', 1) as AiSession['docAccess'],
    aiProviders: HOSTED_FREE_PROVIDERS,
    updateStatus: () => {},
    // A delegated job's cost confirmation: the user starts it.
    confirmJob: async () => ({ allowed: true, note: null })
  })
  return { session, ytext }
}

export async function runTask(task: BenchTask, opts: RunTaskOptions): Promise<TaskResult> {
  const { session, ytext } = makeSession(opts.document, `bench-${task.id}`)
  const model = new ScriptedModel(task.script, ytext)
  const statuses: Array<{ phase: string, key?: string }> = []
  await opts.runAgenticLoop({
    ai: model.ai,
    model: 'zai-glm-5-3-flash',
    systemPrompt: opts.systemPrompt,
    promptContext: opts.promptContext,
    initialPrompt: opts.wrapPrompt(task.prompt),
    aiSession: session,
    sessionId: `bench-${task.id}`,
    abortController: new AbortController(),
    setStatus: (phase, status) => {
      const key = status && typeof status === 'object' && 'step' in status ? status.step?.key : undefined
      statuses.push({ phase, key })
    },
    billingContext: {
      attributedTo: 'user:1',
      billingUserId: 1,
      plan: 'free',
      periodStart: new Date('2026-11-01T00:00:00.000Z'),
      periodEnd: new Date('2026-12-01T00:00:00.000Z'),
      virtualKey: 'sk-bench',
      attribution: 'user'
    },
    logger: () => {},
    crossBoundary: soloSessionGuard()
  })

  const requests = model.requests
  const last = requests[requests.length - 1]
  const finalStatus = statuses[statuses.length - 1]
  const outcome = finalStatus ? `${finalStatus.phase}${finalStatus.key ? `:${finalStatus.key}` : ''}` : 'unknown'
  const scriptFinished = requests.length > 0 && last?.toolCalls === 0 && finalStatus?.phase === 'done'

  const inputChars = requests.reduce((s, r) => s + r.systemChars + r.toolsChars + r.conversationChars, 0)
  const prefixChars = requests.reduce((s, r) => s + r.systemChars + r.toolsChars, 0)
  const outputChars = requests.reduce((s, r) => s + r.outputChars, 0)
  const inputTokens = tokens(inputChars)
  const prefixTokens = tokens(prefixChars)
  const outputTokens = tokens(outputChars)
  const costUncachedUsd = (inputTokens * PRICE_USD_PER_M.input + outputTokens * PRICE_USD_PER_M.output) / 1e6
  const costCachedUsd = ((inputTokens - prefixTokens) * PRICE_USD_PER_M.input + prefixTokens * PRICE_USD_PER_M.cachedInput + outputTokens * PRICE_USD_PER_M.output) / 1e6

  // Time line: per call a fixed overhead plus its output at the assumed speed.
  let elapsed = 0
  let progressAtDeadline = 0
  let progressSoFar = 0
  for (const r of requests) {
    elapsed += PER_CALL_OVERHEAD_SECONDS + tokens(r.outputChars) / OUTPUT_TOKENS_PER_SECOND
    if (r.progress !== null) progressSoFar = r.progress
    if (elapsed <= SESSION_DEADLINE_SECONDS) progressAtDeadline = progressSoFar
  }
  const progress = scriptFinished ? 1 : progressSoFar
  if (scriptFinished && elapsed <= SESSION_DEADLINE_SECONDS) progressAtDeadline = 1

  const withinTurnLimit = scriptFinished
  const withinDeadline = elapsed <= SESSION_DEADLINE_SECONDS
  return {
    id: task.id,
    variant: task.variant,
    title: task.title,
    outcome,
    modelCalls: requests.length,
    toolCalls: requests.reduce((s, r) => s + r.toolCalls, 0),
    toolErrors: model.toolErrors,
    inputChars,
    inputTokens,
    prefixTokens,
    outputChars,
    outputTokens,
    costUncachedUsd,
    costCachedUsd,
    estSeconds: Math.round(elapsed),
    withinTurnLimit,
    withinDeadline,
    feasible: withinTurnLimit && withinDeadline,
    progress,
    progressAtDeadline,
    verifyProblem: scriptFinished && task.verify ? task.verify(opts.document, ytext.toJSON()) : null,
    requests
  }
}
