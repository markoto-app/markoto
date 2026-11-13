import { useDatabasePool } from '../db/client'
import { countStoredEmbeddings, readEmbeddingColumnDims, reconcileEmbeddingColumn } from '../db/embeddingColumn'

// The knowledge vector column as the app sees it at runtime: its declared
// dimension and how many vectors it holds (the boot reconciliation and the
// re-embed tool change it: server/db/embeddingColumn.ts).

export async function readKnowledgeEmbeddingDims(): Promise<number | null> {
  return readEmbeddingColumnDims(useDatabasePool())
}

export async function countKnowledgeEmbeddings(): Promise<number> {
  return countStoredEmbeddings(useDatabasePool())
}
/** The operator-facing explanation of a dimension mismatch. */
export { mismatchMessage } from '../db/embeddingColumn'

/** Boot: retype the vector column to `dims` when no vectors are stored (see `reconcileEmbeddingColumn`). */
export async function reconcileKnowledgeEmbeddingColumn(dims: number): ReturnType<typeof reconcileEmbeddingColumn> {
  return reconcileEmbeddingColumn(useDatabasePool(), dims)
}
