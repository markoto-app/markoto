import { getImportJob, listImportItems } from '../../../repos/imports'
import { importJobParams } from '~~/shared/api/imports'
import { importJobView } from '../../../utils/imports/importJobView'

// One import's progress (the dialog polls it) and, per file, what was not
// imported and why. Only the importer sees it.
export default defineApiHandler({
  access: allow.user(),
  params: importJobParams,
  handler: async ({ self, params }) => {
    const job = await getImportJob(self, params.jobId)
    if (!job) throw apiError('import/job-not-found')
    const problems = await listImportItems(self, params.jobId, { problemsOnly: true, limit: 500 })
    return {
      job: importJobView(job),
      problems: problems.map(p => ({ path: p.relativePath, status: p.status, reason: p.reason }))
    }
  }
})
