import { useDatabasePool } from '../platform/database'
import { readEmbeddingColumnDims, mismatchMessage, countStoredEmbeddings } from './embeddingColumn'
import { parseEmbeddingDims } from '../../../shared/utils/runtime/embeddingConfig'
import { useEnv } from '~~/shared/env/load'

/**
 * Is the knowledge base usable with the current embeddings configuration?
 *
 * Answers "no" (instead of crashing the app) when the configured dimension is
 * invalid or does not match the stored vectors. Only knowledge features
 * (uploads' embedding step, `search_knowledge`) consult this: the editor,
 * sync, auth and everything else keep working, which matters because a
 * misconfigured optional feature must not take a collaborative editor down.
 *
 * The check is a cheap catalog read, cached briefly, and re-evaluated lazily
 * so the status recovers on its own once the re-embed command has run: no
 * restart needed.
 */

export type KnowledgeEmbeddingsStatus
  = | { ok: true }
    | { ok: false, code: 'invalid_config' | 'dimension_mismatch' | 'check_failed', message: string }

const CACHE_TTL_MS = 10_000

let cached: { at: number, status: KnowledgeEmbeddingsStatus } | null = null

async function evaluate(): Promise<KnowledgeEmbeddingsStatus> {
  let target: number
  try {
    target = parseEmbeddingDims(useEnv().litellm.embeddingsDims)
  } catch (e) {
    return { ok: false, code: 'invalid_config', message: e instanceof Error ? e.message : String(e) }
  }
  try {
    const pool = useDatabasePool()
    const current = await readEmbeddingColumnDims(pool)
    if (current === target) return { ok: true }
    const stored = await countStoredEmbeddings(pool)
    return { ok: false, code: 'dimension_mismatch', message: mismatchMessage(current, target, stored) }
  } catch (e) {
    return { ok: false, code: 'check_failed', message: `Could not verify the embedding column: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export async function getKnowledgeEmbeddingsStatus(): Promise<KnowledgeEmbeddingsStatus> {
  const now = Date.now()
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.status
  const status = await evaluate()
  cached = { at: now, status }
  return status
}

/** Throws an operator-actionable error when knowledge features are disabled. */
export async function assertKnowledgeEmbeddingsReady(): Promise<void> {
  const status = await getKnowledgeEmbeddingsStatus()
  if (!status.ok) throw new Error(`[embeddings] ${status.message}`)
}

/** Drop the cached answer (boot reconciliation just changed the column; tests). */
export function resetKnowledgeEmbeddingsStatus(): void {
  cached = null
}
