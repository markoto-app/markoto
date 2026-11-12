import * as Sentry from '@sentry/nuxt'
import { useDatabasePool } from '../utils/platform/database'
import { migrationsComplete } from '../utils/platform/migrations'
import { reconcileEmbeddingColumn } from '../utils/knowledge/embeddingColumn'
import { resetKnowledgeEmbeddingsStatus } from '../utils/knowledge/knowledgeEmbeddingsStatus'
import { DEFAULT_EMBEDDINGS_DIMS, parseEmbeddingDims } from '../../shared/utils/runtime/embeddingConfig'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../utils/platform/logger'

const log = useLogger('embeddings')

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
      dims = parseEmbeddingDims(useEnv().litellm.embeddingsDims ?? DEFAULT_EMBEDDINGS_DIMS)
    } catch (e) {
      log.error('Knowledge features disabled', { err: e })
      return
    }
    try {
      const result = await reconcileEmbeddingColumn(useDatabasePool(), dims)
      resetKnowledgeEmbeddingsStatus()
      switch (result.action) {
        case 'noop':
          break
        case 'altered':
          log.info('knowledge vector column retyped (no vectors were stored)', { previousDims: result.previousDims ?? 'unsized', currentDims: result.currentDims })
          break
        case 'refused':
        case 'busy':
          log.error('knowledge features disabled', { reason: result.message })
          Sentry.captureMessage(`embedding dimension reconcile: ${result.action}`, {
            level: 'warning',
            tags: { component: 'embeddings', event: `reconcile_${result.action}` }
          })
          break
      }
    } catch (e) {
      log.error('Dimension reconciliation failed; knowledge features may be disabled', { err: e })
      Sentry.captureException(e, { tags: { component: 'embeddings', event: 'reconcile_failed' } })
    }
  })()
})
