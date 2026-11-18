import { listImportJobs } from '../../repos/imports'
import { listImportsQuery } from '~~/shared/api/imports'
import { importJobView } from '../../utils/imports/importJobView'

// The caller's recent imports (the import dialog and the explorer's
// progress strip), optionally only those into one workspace or personal.
export default defineApiHandler({
  access: allow.user(),
  query: listImportsQuery,
  handler: async ({ self, query }) => {
    const scope = query.workspaceId === undefined ? null : { workspaceId: query.workspaceId === 'personal' ? null : query.workspaceId }
    return { jobs: (await listImportJobs(self, scope, 10)).map(importJobView) }
  }
})
