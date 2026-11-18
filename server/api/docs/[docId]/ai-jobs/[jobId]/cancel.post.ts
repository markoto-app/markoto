import { cancelJob, getJobReport } from '../../../../../utils/ai/jobs/engine'
import { toJobView } from '../../../../../utils/ai/jobs/jobView'
import { aiJobActionBody, aiJobParams } from '~~/shared/api/ai'

// POST /api/docs/:docId/ai-jobs/:jobId/cancel: stop a delegated job. What
// it already wrote stays (Undo is separate). The person who started it, or
// whoever manages the document (owner, workspace admin); 404 for anyone
// else who can edit, the same as for an unknown job.
export default defineApiHandler({
  access: allow.doc('write-content'),
  params: aiJobParams,
  body: aiJobActionBody,
  handler: async ({ user, docId, docAccess, prove, params }) => {
    const { job } = await getJobReport(docAccess, params.jobId, 0)
    if (job.initiatorUserId !== user.id && !(await prove.doc(docId, 'manage'))) throw apiError('ai/job-not-found')
    return { job: toJobView(await cancelJob(docAccess, job.id)) }
  }
})
