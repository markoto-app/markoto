import { describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createPatch } from 'diff'
import * as Y from 'yjs'
import type { AiSession } from '../../../server/utils/ai/aiClient'
import type { BillingContext } from '../../../server/utils/billing/billing'
import type { ResolvedAiProviders } from '../../../server/utils/aiProviders/resolve'
import type { AgenticContent } from '../../../server/utils/agentic/aiTypes'
import { soloSessionGuard } from '../../unit/fixtures/crossBoundary'
import { docAs } from '../../helpers/access'
import { partial } from '../../helpers/fixtures'
import { largeDocument } from './fixtures'
import { lineChanges, PLANNER_TASKS, smallDocText, writingCheck, type EvalComment } from './tasks'
import { makeLiveClient, type CallRecord } from './liveClient'
import { BudgetExceeded, spentUsd } from './pricing'

// Live planner eval: the CURRENT agentic loop (runAgenticLoop on this
// branch = markoto/main) end to end against real models through a local
// LiteLLM. Manual only:
//   EVAL_PLANNER=1 EVAL_MODELS=a,b EVAL_TASKS=L1,S1 EVAL_REPS=1 bunx vitest run --project bench tests/bench/model-eval/planner.bench.test.ts

const messages: string[] = []
vi.mock('../../../server/repos/aiSessionMessages', () => ({
  appendAiMessage: vi.fn(async (_access: unknown, row: { kind: string, body: { message?: string } }) => {
    if (row.kind === 'message_to_user' && row.body.message) messages.push(row.body.message)
  }),
  loadRecentMessages: vi.fn(async () => []),
  lastActivityAt: vi.fn(async () => null)
}))
vi.mock('../../../server/repos/documents', async orig => ({
  ...(await orig<object>()),
  updateDocMeta: vi.fn(async () => {})
}))

const { runAgenticLoop } = await import('../../../server/utils/agentic/runLoop')
const { assemblePromptSystemPrompt, PROMPT_SYSTEM_PROMPT } = await import('../../../server/utils/agentic/promptAssembly')
const { buildDocumentContext } = await import('../../../server/utils/agentic/documentContextPrompt')
const { validateEditorSelection, wrapPromptWithEditorState } = await import('../../../server/utils/agentic/editorStatePrompt')

const ENABLED = process.env.EVAL_PLANNER === '1'
const MODELS = (process.env.EVAL_MODELS ?? 'zai-glm-5-3-flash').split(',')
const TASK_FILTER = (process.env.EVAL_TASKS ?? '').split(',').filter(Boolean)
const REPS = Number(process.env.EVAL_REPS ?? '1')
const REP_OFFSET = Number(process.env.EVAL_REP_OFFSET ?? '0')
const LABEL = process.env.EVAL_LABEL ?? 'main'
const OUT_DIR = (process.env.EVAL_OUT_DIR ?? 'tests/bench/model-eval/results')
const RESULTS = `${OUT_DIR}/planner-${LABEL}.jsonl`
const ARTIFACTS = `${OUT_DIR}/planner-runs`

const LARGE = largeDocument()
const tasks = PLANNER_TASKS.filter(t => TASK_FILTER.length === 0 || TASK_FILTER.some(f => t.id.startsWith(f)))

function providersFor(model: string): ResolvedAiProviders {
  const providers: ResolvedAiProviders = { chat: { capability: 'chat', source: 'instance', model, credentials: null, supportsVision: true }, image: null, transcription: null }
  return providers
}

function readComments(ydoc: Y.Doc): EvalComment[] {
  const arr = ydoc.getArray<Y.Map<unknown>>('comments')
  const out: EvalComment[] = []
  const pos = (b64: unknown): number | null => {
    if (typeof b64 !== 'string') return null
    const rel = Y.decodeRelativePosition(Buffer.from(b64, 'base64'))
    return Y.createAbsolutePositionFromRelativePosition(rel, ydoc)?.index ?? null
  }
  for (let i = 0; i < arr.length; i++) {
    const m = arr.get(i)
    if (!(m instanceof Y.Map)) continue
    out.push({ body: String(m.get('body') ?? ''), anchorStart: pos(m.get('anchorStart')), anchorEnd: pos(m.get('anchorEnd')) })
  }
  return out
}

interface ToolEvent { name: string, args: string, isError?: boolean, output?: string }

describe.skipIf(!ENABLED)('live planner eval (current loop)', () => {
  mkdirSync(ARTIFACTS, { recursive: true })
  for (const model of MODELS) {
    for (const task of tasks) {
      for (let rep = REP_OFFSET; rep < REP_OFFSET + REPS; rep++) {
        it(`${model} ${task.id} #${rep}`, async () => {
          if (spentUsd() >= Number(process.env.EVAL_BUDGET_USD ?? '14')) {
            expect(spentUsd()).toBeGreaterThan(0)
            return
          }
          messages.length = 0
          const initial = task.doc === 'large' ? LARGE : smallDocText(task.doc)!
          const ydoc = new Y.Doc()
          const ytext = ydoc.getText('content')
          ytext.insert(0, initial)
          const started = Date.now()
          let firstEditAt: number | null = null
          ydoc.on('update', () => {
            if (firstEditAt === null) firstEditAt = Date.now()
          })
          const runId = `${LABEL}-${model}-${task.id}-${rep}`
          const docId = `Eval${task.doc.replace(/\W/g, '')}01`
          const calls: CallRecord[] = []
          const tools: ToolEvent[] = []
          const statuses: string[] = []
          const base = makeLiveClient(model, `planner-${LABEL}`, calls, `doc:${docId}`)
          // Collect tool calls and results from the conversation the loop sends.
          let seenParts = 0
          const ai = {
            models: {
              generateContentStream: async (args: Parameters<typeof base.models.generateContentStream>[0]) => {
                const contents = args.contents as AgenticContent[]
                const flat = contents.flatMap(c => c.parts ?? [])
                for (const p of flat.slice(seenParts)) {
                  if (p.functionCall) tools.push({ name: p.functionCall.name ?? '', args: JSON.stringify(p.functionCall.args ?? {}).slice(0, 400) })
                  if (p.functionResponse) {
                    const r = p.functionResponse.response as { output?: unknown, isError?: unknown } | undefined
                    const match = [...tools].reverse().find(t => t.name === p.functionResponse!.name && t.isError === undefined)
                    if (match) {
                      match.isError = r?.isError === true
                      match.output = String(r?.output ?? '').slice(0, 300)
                    }
                  }
                }
                seenParts = flat.length
                return await base.models.generateContentStream(args)
              }
            }
          }
          const ydocDone = { ydoc }
          const session = partial<AiSession>({
            ydoc,
            ytext,
            ymeta: ydoc.getMap('meta'),
            sessionId: runId,
            docId,
            initiatorUserId: 1,
            workspaceId: null,
            docAccess: docAs(docId, 1) as AiSession['docAccess'],
            aiProviders: providersFor(model),
            updateStatus: () => {}
          })
          const systemPrompt = assemblePromptSystemPrompt(PROMPT_SYSTEM_PROMPT, {
            documentContextBlock: buildDocumentContext({ title: task.doc === 'large' ? 'Betriebshandbuch IT- und Netzbetrieb' : task.doc === 'paper' ? 'Battery degradation paper' : 'Jahresbericht Werkstatt Nord', description: '', audience: task.audience as never, language: task.language }),
            knowledgeBlock: '',
            membersBlock: ''
          })
          const billingContext: BillingContext = { attributedTo: 'user:1', billingUserId: 1, plan: 'free', periodStart: new Date(), periodEnd: new Date(), virtualKey: 'sk-eval', attribution: 'user' }
          let error: string | null = null
          // Production aborts a session after AI_SESSION_HARD_DEADLINE_MS (5 min).
          const abortController = new AbortController()
          const deadline = setTimeout(() => abortController.abort(), 300_000)
          try {
            await runAgenticLoop({
              ai,
              model,
              systemPrompt,
              initialPrompt: wrapPromptWithEditorState(task.prompt, validateEditorSelection(undefined)),
              aiSession: session,
              sessionId: runId,
              abortController,
              setStatus: (phase, status) => {
                const key = status && typeof status === 'object' && 'step' in status ? status.step?.key : undefined
                statuses.push(`${phase}${key ? `:${key}` : ''}`)
              },
              billingContext,
              logger: () => {},
              crossBoundary: soloSessionGuard()
            })
          } catch (e) {
            error = abortController.signal.aborted ? 'deadline (5 min)' : e instanceof BudgetExceeded ? `budget: ${e.message}` : (e instanceof Error ? e.message : String(e))
          }
          clearTimeout(deadline)
          const ended = Date.now()
          const final = ytext.toJSON()
          const comments = readComments(ydocDone.ydoc)
          const verdict = task.verify(initial, final, comments)
          const { added } = lineChanges(initial, final)
          const written = [...(task.id.startsWith('L3') || task.id.startsWith('L2') || task.id.startsWith('S1') ? [] : added), ...comments.map(c => c.body), ...messages].join('\n')
          const sum = (k: keyof CallRecord): number => calls.reduce((s, c) => s + (c[k] as number), 0)
          const toolErrors = tools.filter(t => t.isError).length
          const argErrors = tools.filter(t => t.isError && /invalid|argument|expected|required|schema/i.test(t.output ?? '')).length
          const result = {
            label: LABEL,
            model,
            task: task.id,
            rep,
            ok: verdict.ok,
            score: verdict.score,
            detail: verdict.detail,
            outcome: statuses[statuses.length - 1] ?? 'unknown',
            error,
            turns: calls.length,
            toolCalls: tools.length,
            toolErrors,
            argErrors,
            toolNames: tools.map(t => t.name),
            prompt: sum('prompt'),
            cached: sum('cached'),
            output: sum('output'),
            reasoning: sum('reasoning'),
            cacheHit: sum('prompt') ? sum('cached') / sum('prompt') : 0,
            usd: sum('usd'),
            wallMs: ended - started,
            firstEditMs: firstEditAt === null ? null : firstEditAt - started,
            meanTtftMs: calls.length ? calls.reduce((s, c) => s + Math.max(0, c.ttftMs), 0) / calls.length : 0,
            outputTokPerSec: sum('totalMs') ? sum('output') / (sum('totalMs') / 1000) : 0,
            writing: writingCheck(written),
            calls
          }
          appendFileSync(RESULTS, `${JSON.stringify(result)}\n`)
          writeFileSync(`${ARTIFACTS}/${runId}.json`, JSON.stringify({ ...result, messages, comments, tools, added, patch: createPatch('doc.md', initial, final, '', '', { context: 2 }) }, null, 2))
          expect(result.turns).toBeGreaterThanOrEqual(0)
          console.log(`${runId}: ok=${verdict.ok} score=${verdict.score.toFixed(2)} ${verdict.detail} turns=${calls.length} tools=${tools.length} err=${toolErrors} $${result.usd.toFixed(4)} ${(result.wallMs / 1000).toFixed(0)}s cache=${(result.cacheHit * 100).toFixed(0)}% ${error ?? ''}`)
        }, 900_000)
      }
    }
  }
})
