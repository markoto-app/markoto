import { listDocJobs } from '../../../../utils/ai/jobs/engine'
import { toJobView } from '../../../../utils/ai/jobs/jobView'

// GET /api/docs/:docId/ai-jobs: the caller's own delegated AI jobs on this
// document, newest first (the prompt bar picks up a running one after a
// reload). Other people's jobs are not listed: a job's progress belongs to
// the person who started it, like the AI session channel.
export default defineApiHandler({
  access: allow.doc('write-content'),
  handler: async ({ user, docAccess }) => {
    const jobs = await listDocJobs(docAccess)
    return { jobs: jobs.filter(j => j.initiatorUserId === user.id).slice(0, 10).map(toJobView) }
  }
})
