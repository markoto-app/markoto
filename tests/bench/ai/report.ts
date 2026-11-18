import {
  CHARS_PER_TOKEN,
  MAX_TURNS,
  OUTPUT_TOKENS_PER_SECOND,
  PER_CALL_OVERHEAD_SECONDS,
  PRICE_USD_PER_M,
  SESSION_DEADLINE_SECONDS,
  type StaticPrefix,
  type TaskResult
} from './harness'

// Markdown rendering of one benchmark run (tests/bench/ai/results/<label>.md).

export interface DocumentInfo { chars: number, words: number, lines: number, tokens: number }

const usd = (n: number): string => `$${n.toFixed(4)}`
const k = (n: number): string => n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n.toLocaleString('en-US')
const pct = (n: number): string => `${Math.round(n * 100)} %`
const yesNo = (b: boolean): string => (b ? 'yes' : 'no')

export function renderMarkdownReport(label: string, doc: DocumentInfo, prefix: StaticPrefix, results: readonly TaskResult[]): string {
  const rows = results.map(r => [
    `${r.id} (${r.variant})`,
    r.title,
    r.modelCalls,
    r.toolCalls,
    k(r.inputTokens),
    k(r.inputChars),
    k(r.outputTokens),
    usd(r.costUncachedUsd),
    usd(r.costCachedUsd),
    `${r.estSeconds} s`,
    r.outcome,
    `${yesNo(r.feasible)}${r.feasible ? '' : ` (turns: ${yesNo(r.withinTurnLimit)}, time: ${yesNo(r.withinDeadline)})`}`,
    `${pct(r.progress)} / ${pct(r.progressAtDeadline)}`
  ].join(' | '))

  const total = (f: (r: TaskResult) => number): number => results.reduce((s, r) => s + f(r), 0)

  const delegated = results.filter(r => r.worker)
  const workerRows = delegated.map((r) => {
    const w = r.worker!
    return `| ${r.id} (${r.variant}) | ${w.calls} | ${k(w.inputTokens)} | ${k(w.outputTokens)} | ${usd(w.costUncachedUsd)} | ${usd(w.costCachedUsd)} | ${w.estimate ? `${w.estimate.units} units, ${usd(w.estimate.usd ?? 0)}, ${w.estimate.minutes} min` : '-'} | ${usd(r.costCachedUsd + w.costCachedUsd)} |`
  })
  const workerSection = delegated.length === 0
    ? []
    : [
        '## Delegated jobs: modelled worker calls',
        '',
        'The planner session above only previews, starts and reports a job; the job\'s worker calls run outside it. They are modelled with the pure job modules (`buildJobUnits`, `maskText`, `buildWorkerPrompt`: input = the exact worker prompt per unit, output = the unit\'s masked text) on the `markoto-worker` alias price (GLM-5.3 Flash: $0.165 / $0.033 cached / $0.55 per M), the system prompt and job part cached after a job\'s first call. Preview calls included.',
        '',
        '| Task | Worker calls | Input tokens | Output tokens | Cost uncached | Cost cached prefix | Server estimate | Planner + worker (cached) |',
        '|---|--:|--:|--:|--:|--:|---|--:|',
        ...workerRows,
        ''
      ]

  return [
    `# AI loop benchmark: ${label}`,
    '',
    'Scripted-planner benchmark (`bun run bench:ai`, `tests/bench/ai/`): the real `runAgenticLoop` with a fake model whose tool calls are scripted per task, the real tool handlers on a Y.Doc holding the large fixture (`tests/e2e/fixtures/content/large-handbook/`). Every request the loop sends is measured.',
    '',
    `Document: ${doc.words.toLocaleString('en-US')} words, ${doc.chars.toLocaleString('en-US')} chars, ${doc.lines.toLocaleString('en-US')} lines, about ${doc.tokens.toLocaleString('en-US')} tokens.`,
    '',
    '## Static prefix (sent with every request)',
    '',
    '| Part | Chars | Tokens (est.) |',
    '|---|--:|--:|',
    `| System prompt (PROMPT_SYSTEM_PROMPT; the document context opens the first user message) | ${prefix.systemPromptChars.toLocaleString('en-US')} | ${prefix.systemPromptTokens.toLocaleString('en-US')} |`,
    `| Tool declarations (${prefix.toolCount} tools, OpenAI JSON) | ${prefix.toolsChars.toLocaleString('en-US')} | ${prefix.toolsTokens.toLocaleString('en-US')} |`,
    `| Total | ${(prefix.systemPromptChars + prefix.toolsChars).toLocaleString('en-US')} | ${(prefix.systemPromptTokens + prefix.toolsTokens).toLocaleString('en-US')} |`,
    '',
    '## Tasks',
    '',
    '| Task | What | Model calls | Tool calls | Input tokens | Input chars | Output tokens | Cost uncached | Cost cached prefix | Est. time | Outcome | Feasible | Progress (end / at 5 min) |',
    '|---|---|--:|--:|--:|--:|--:|--:|--:|--:|---|---|---|',
    ...rows.map(r => `| ${r} |`),
    `| **Total** | | ${total(r => r.modelCalls)} | ${total(r => r.toolCalls)} | ${k(total(r => r.inputTokens))} | ${k(total(r => r.inputChars))} | ${k(total(r => r.outputTokens))} | ${usd(total(r => r.costUncachedUsd))} | ${usd(total(r => r.costCachedUsd))} | | | | |`,
    '',
    ...workerSection,
    '## Method and assumptions',
    '',
    `- Tokens = characters / ${CHARS_PER_TOKEN} (German prose on current BPE tokenizers; JSON and line-numbered tool output counted the same way). Characters are the message contents and tool-call names + JSON arguments of the OpenAI-shape request the loop would send (\`internalToOpenAIMessages\`), plus the tool declarations JSON (\`internalToOpenAITools\`); no per-message framing tokens.`,
    '- Input tokens are summed over every model call of the session (each call resends the whole history).',
    '- Output tokens = characters of the emitted tool calls (name + JSON arguments) / 3.6. Reasoning tokens (GLM-5.3 Flash at `reasoning_effort: low`: 0 to ~130 per edit turn) and the closing turn\'s text are not counted.',
    `- Prices: Z.ai GLM-5.3 Flash on Mistral's EU endpoint, the hosted chat default: $${PRICE_USD_PER_M.input} input, $${PRICE_USD_PER_M.cachedInput} cached input, $${PRICE_USD_PER_M.output} output per million tokens (\`docs/AI-MODELS.md\`, model table).`,
    '- "Cost cached prefix": the static prefix (system prompt + tools) of every call billed at the cached input price, everything else uncached. That matches the measured behaviour in `docs/AI-MODELS.md` (hits only on the prefix every user shares; the growing session history is rarely reused). Uncached = no hit at all (about a third of calls in production).',
    `- Time: ${PER_CALL_OVERHEAD_SECONDS} s per model call plus output at ${OUTPUT_TOKENS_PER_SECOND} tokens/s; prefill time of the large input is NOT included, so real sessions take longer.`,
    `- Feasible = the script finished within MAX_TURNS (${MAX_TURNS}) AND the estimated time is within the ${SESSION_DEADLINE_SECONDS / 60}-minute session deadline. Progress = share of the task done when the session ended / by the deadline (T6: share of the document's characters rewritten).`,
    '- Scripts play a competent model with today\'s tools: read the whole document with `view_document`, then edit with `replace_text` (old_str copied from the view) / `insert_text` / `create_comment`. Rewrites (translation, tone) are same-length stand-ins.',
    ''
  ].join('\n')
}
