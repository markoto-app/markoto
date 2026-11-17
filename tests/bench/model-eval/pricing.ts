import { appendFileSync, existsSync, readFileSync } from 'node:fs'

// List prices in USD per million tokens (input / cached input / output).
// Mistral's EU endpoint bills 1.1 x list (deploy/config/litellm/config.yaml).
// Ministral cached-input prices are not published; assumed 10 % of input
// like Mistral's other models (only matters if the API reports cache hits).

export const EU_FACTOR = 1.1

export const LIST_PRICES: Record<string, { input: number, cached: number, output: number }> = {
  'zai-glm-5-3-flash': { input: 0.15, cached: 0.03, output: 0.50 },
  'deepseek-v4-1-flash-1017': { input: 0.30, cached: 0.007, output: 1.20 },
  'mistral-small-2603': { input: 0.15, cached: 0.015, output: 0.60 },
  'mistral-large-4': { input: 0.70, cached: 0.07, output: 2.10 },
  'ministral-3b-2512': { input: 0.10, cached: 0.01, output: 0.10 },
  'ministral-8b-2512': { input: 0.15, cached: 0.015, output: 0.15 },
  'ministral-14b-2512': { input: 0.20, cached: 0.02, output: 0.20 }
}

export interface CallUsage {
  prompt: number
  cached: number
  output: number
  reasoning: number
}

/** EU cost in USD of one call. Reasoning tokens are part of `output` (billed as output). */
export function costUsd(model: string, u: CallUsage): number {
  const p = LIST_PRICES[model]
  if (!p) throw new Error(`no price for ${model}`)
  return EU_FACTOR * ((u.prompt - u.cached) * p.input + u.cached * p.cached + u.output * p.output) / 1e6
}

export const LEDGER = process.env.EVAL_LEDGER ?? `${process.env.EVAL_OUT_DIR ?? 'tests/bench/model-eval/results'}/ledger.jsonl`
export const BUDGET_USD = Number(process.env.EVAL_BUDGET_USD ?? '14')

export function spentUsd(): number {
  if (!existsSync(LEDGER)) return 0
  return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).reduce((s, l) => s + (JSON.parse(l) as { usd: number }).usd, 0)
}

export class BudgetExceeded extends Error {}

export function assertBudget(): void {
  const spent = spentUsd()
  if (spent >= BUDGET_USD) throw new BudgetExceeded(`eval budget reached: $${spent.toFixed(3)} of $${BUDGET_USD}`)
}

export function recordSpend(entry: { experiment: string, model: string, usage: CallUsage, usd: number, tag?: string }): void {
  appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}
