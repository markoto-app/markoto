import { getJobReport } from '../../../../../utils/ai/jobs/engine'
import { toJobNotes, toJobView } from '../../../../../utils/ai/jobs/jobView'
import { aiJobParams } from '~~/shared/api/ai'

// GET /api/docs/:docId/ai-jobs/:jobId: one job's progress and the parts it
// skipped or flagged (heading and reason). Initiator only: 404 for anybody
// else, the same answer as for an unknown job.
export default defineApiHandler({
  access: allow.doc('write-content'),
  params: aiJobParams,
  handler: async ({ user, docAccess, params }) => {
    const report = await getJobReport(docAccess, params.jobId)
    if (report.job.initiatorUserId !== user.id) throw apiError('ai/job-not-found')
    return { job: toJobView(report.job), notes: toJobNotes(report.notes) }
  }
})
