import { dailySpendForRollup } from '../../repos/litellmSpend'
import { upsertAiSpendDaily } from '../../repos/aiSpendDaily'
import { system } from '../../repos/proofs'
import { DAY_MS } from '~~/shared/config/units'
import { SPEND_LOG_RETENTION_DAYS } from './spendLogsSweep'

// Rolls LiteLLM's spend logs up into `ai_spend_daily` (per day, feature and
// model: cost, requests, distinct users; no user or document id), so the
// admin's AI cost history outlives the raw rows, which `spend-logs-sweep`
// deletes after SPEND_LOG_RETENTION_DAYS days because they name users and
// documents.
//
// Each run recomputes every finished day the raw rows still fully cover
// (the oldest day is partly deleted by the retention cut, so it is left
// out) and overwrites those rollup rows. The first run therefore backfills
// everything the logs hold; later runs keep the last days current, and a
// day keeps its last full count once its raw rows are gone.

/** Days before today whose raw rows are complete: a margin of two days below the retention cut. */
export const ROLLUP_DAYS = SPEND_LOG_RETENTION_DAYS - 2

export function rollupWindow(now: Date): { from: string, to: string } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return {
    from: new Date(today - ROLLUP_DAYS * DAY_MS).toISOString().slice(0, 10),
    // Yesterday: today is still being written.
    to: new Date(today - DAY_MS).toISOString().slice(0, 10)
  }
}

export async function runAiSpendRollup(now: Date = new Date()): Promise<{ rows: number }> {
  const by = system('ai-spend-rollup')
  const rows = await dailySpendForRollup(by, rollupWindow(now))
  return { rows: await upsertAiSpendDaily(by, rows) }
}
