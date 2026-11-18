import { getJobReport, startJob } from '../../../../../utils/ai/jobs/engine'
import { toJobView } from '../../../../../utils/ai/jobs/jobView'
import { aiJobActionBody, aiJobParams } from '~~/shared/api/ai'

// POST /api/docs/:docId/ai-jobs/:jobId/resume: continue a job that was
// cancelled, paused by the budget or interrupted by a restart. Its pending
// parts run again on the initiator's budget, each re-checked against the
// text it had at job start. The initiator, or the document's owner /
// workspace admin; 404 for anyone else.
export default defineApiHandler({
  access: allow.doc('write-content'),
  params: aiJobParams,
  body: aiJobActionBody,
  handler: async ({ event, user, docId, docAccess, prove, params }) => {
    const { job } = await getJobReport(docAccess, params.jobId, 0)
    if (job.initiatorUserId !== user.id && !(await prove.doc(docId, 'manage'))) throw apiError('ai/job-not-found')
    return { job: toJobView(await startJob(docAccess, job.id, getClientIp(event))) }
  }
})
