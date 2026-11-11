import * as Sentry from '@sentry/nuxt'
import { useDatabasePool } from '../utils/platform/database'
import { migrationsComplete } from '../utils/platform/migrations'
import { reconcileEmbeddingColumn } from '../utils/knowledge/embeddingColumn'
import { resetKnowledgeEmbeddingsStatus } from '../utils/knowledge/knowledgeEmbeddingsStatus'
import { DEFAULT_EMBEDDINGS_DIMS, parseEmbeddingDims } from '../../shared/utils/embeddingConfig'

// After migrations: make the pgvector column match NUXT_LITELLM_EMBEDDINGS_DIMS
// (see server/utils/knowledge/embeddingColumn.ts for the rules). Never fails the boot:
// a bad or conflicting embeddings setup only disables knowledge features,
// reported via logs, Sentry and /api/health/deep (`checks.embeddings`).
export default defineNitroPlugin(() => {
  if (import.meta.prerender) return

  void (async () => {
    await migrationsComplete
    let dims: number
    try {
      dims = parseEmbeddingDims(useRuntimeConfig().litellm?.embeddingsDims ?? DEFAULT_EMBEDDINGS_DIMS)
    } catch (e) {
      console.error('[embeddings] Knowledge features disabled:', e instanceof Error ? e.message : e)
      return
    }
    try {
      const result = await reconcileEmbeddingColumn(useDatabasePool(), dims)
      resetKnowledgeEmbeddingsStatus()
      switch (result.action) {
        case 'noop':
          break
        case 'altered':
          console.log(`[embeddings] Knowledge vector column retyped ${result.previousDims ?? 'unsized'} -> ${result.currentDims} dims (no vectors were stored).`)
          break
        case 'refused':
        case 'busy':
          console.error(`[embeddings] Knowledge features disabled: ${result.message}`)
          Sentry.captureMessage(`embedding dimension reconcile: ${result.action}`, {
            level: 'warning',
            tags: { component: 'embeddings', event: `reconcile_${result.action}` }
          })
          break
      }
    } catch (e) {
      console.error('[embeddings] Dimension reconciliation failed; knowledge features may be disabled:', e instanceof Error ? e.message : e)
      Sentry.captureException(e, { tags: { component: 'embeddings', event: 'reconcile_failed' } })
    }
  })()
})
