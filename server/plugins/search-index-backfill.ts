import { listUnindexedDocIds } from '../repos/documentSearch'
import { system } from '../repos/proofs'
import { reindexDocument } from '../utils/documents/searchIndex'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'

// Indexes documents that have no `document_search` row: every document that
// existed before search shipped, and any whose store happened while the
// table was missing (sync server deployed before the migration ran). A batch
// per run; once everything is indexed a run is one cheap query. Until a
// document is indexed, search still finds it by title.

const BATCH = 50
const by = system('search-index')

export default defineSweeper({
  name: 'search-index-backfill',
  schedule: SWEEPS.searchIndexBackfill,
  run: async () => {
    const docIds = await listUnindexedDocIds(by, BATCH)
    for (const docId of docIds) await reindexDocument(by.doc(docId))
    return docIds.length > 0 ? { indexed: docIds.length } : undefined
  }
})
