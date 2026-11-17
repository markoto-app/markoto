// Prices of the bundled worker aliases (deploy/config/litellm/config.yaml),
// in USD per token, for the cost estimate shown before a delegated job
// starts. The proxy's spend log stays the source of truth for what is
// charged; this table only predicts it. `tests/unit/litellm/workerPrices.test.ts`
// parses config.yaml and fails when the two disagree.

export interface WorkerPrice {
  /** USD per uncached input token. */
  input: number
  /** USD per output token. */
  output: number
  /** USD per cached input token (the input price when the alias states none). */
  cachedInput: number
}

export const WORKER_PRICES = {
  'markoto-worker': { input: 0.000000165, output: 0.00000055, cachedInput: 0.000000033 },
  'markoto-utility': { input: 0.000000165, output: 0.00000055, cachedInput: 0.000000033 },
  'markoto-worker-strong': { input: 0.000000165, output: 0.00000066, cachedInput: 0.0000000165 }
} as const satisfies Record<string, WorkerPrice>

export type WorkerAlias = keyof typeof WORKER_PRICES

/** The price of a platform worker alias, or null for any other model (BYOK, operator endpoints). */
export function workerPrice(model: string): WorkerPrice | null {
  return Object.hasOwn(WORKER_PRICES, model) ? WORKER_PRICES[model as WorkerAlias] : null
}
