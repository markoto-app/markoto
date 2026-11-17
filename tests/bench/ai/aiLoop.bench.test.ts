import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateLargeDocument, LARGE_DOC_TITLE } from '../../fixtures/largeDocument/generate'
import { assemblePromptContext, PROMPT_SYSTEM_PROMPT } from '../../../server/utils/agentic/promptAssembly'
import { buildDocumentContext } from '../../../server/utils/agentic/documentContextPrompt'
import { validateEditorSelection, wrapPromptWithEditorState } from '../../../server/utils/agentic/editorStatePrompt'
import { ALL_TOOL_DECLARATIONS, filterToolsForProviders } from '../../../server/utils/ai/tools/registry'
import { HOSTED_FREE_PROVIDERS, runTask, tokens, toolsJsonChars, type StaticPrefix, type TaskResult } from './harness'
import { BASELINE_TASKS } from './tasks'
import { renderMarkdownReport } from './report'

// Offline AI-loop benchmark on the large-document fixture: `bun run bench:ai`
// (label from AI_BENCH_LABEL, default `current`). Writes
// tests/bench/ai/results/<label>.json and .md. Not part of `bun run test`.

// Conversation memory rows (message_to_user) would need the database.
vi.mock('../../../server/repos/aiSessionMessages', () => ({
  appendAiMessage: vi.fn(async () => {}),
  loadRecentMessages: vi.fn(async () => []),
  lastActivityAt: vi.fn(async () => null)
}))

const { runAgenticLoop } = await import('../../../server/utils/agentic/runLoop')

// Plain process.env: these only steer a manual run (which file to write, and
// that `vitest run` without `bun run bench:ai` skips the benchmark).

const LABEL = (process.env.AI_BENCH_LABEL ?? 'current').replace(/[^\w.-]/g, '_')

const ENABLED = process.env.AI_BENCH === '1'
const RESULTS_DIR = fileURLToPath(new URL('./results/', import.meta.url))

const document = generateLargeDocument()
const systemPrompt = PROMPT_SYSTEM_PROMPT
const promptContext = assemblePromptContext({
  documentContextBlock: buildDocumentContext({ title: LARGE_DOC_TITLE, description: '', audience: 'technical', language: 'de-CH' }),
  knowledgeBlock: '',
  membersBlock: ''
})
const wrapPrompt = (prompt: string): string => wrapPromptWithEditorState(prompt, validateEditorSelection(undefined))

const results: TaskResult[] = []

describe.skipIf(!ENABLED)('AI loop benchmark (scripted planner, large document)', () => {
  beforeEach(() => {
    // The hosted SaaS offers web_search / fetch_url (operator keys set).
    vi.stubEnv('STAAN_API_KEY', 'bench-staan-key')
    vi.stubEnv('JINA_AI_API_KEY', 'bench-jina-key')
  })

  for (const task of BASELINE_TASKS) {
    it(`${task.id} (${task.variant})`, async () => {
      const result = await runTask(task, { runAgenticLoop, document, systemPrompt, promptContext, wrapPrompt })
      results.push(result)
      expect(result.modelCalls).toBeGreaterThan(0)
      // A finished script must have edited the document as intended.
      expect(result.verifyProblem).toBeNull()
    }, 120_000)
  }

  it('writes the results', () => {
    const declarations = filterToolsForProviders(ALL_TOOL_DECLARATIONS, HOSTED_FREE_PROVIDERS, { search: true, fetch: true })
    const toolsChars = toolsJsonChars(declarations)
    const prefix: StaticPrefix = {
      systemPromptChars: systemPrompt.length,
      systemPromptTokens: tokens(systemPrompt.length),
      toolCount: declarations.length,
      toolsChars,
      toolsTokens: tokens(toolsChars)
    }
    const docInfo = { chars: document.length, words: document.split(/\s+/).filter(Boolean).length, lines: document.split('\n').length, tokens: tokens(document.length) }
    mkdirSync(RESULTS_DIR, { recursive: true })
    writeFileSync(`${RESULTS_DIR}${LABEL}.json`, `${JSON.stringify({ label: LABEL, document: docInfo, prefix, tasks: results }, null, 2)}\n`)
    writeFileSync(`${RESULTS_DIR}${LABEL}.md`, renderMarkdownReport(LABEL, docInfo, prefix, results))
    expect(results).toHaveLength(BASELINE_TASKS.length)
  })
})
