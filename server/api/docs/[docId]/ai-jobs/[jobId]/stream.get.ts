import { getJobProgress, getJobReport, subscribeJobProgress } from '../../../../../utils/ai/jobs/engine'
import { createJobEventStream } from '../../../../../utils/ai/jobs/jobStream'
import { aiJobParams } from '~~/shared/api/ai'

// GET /api/docs/:docId/ai-jobs/:jobId/stream: Server-Sent Events push of a
// job's progress (`utils/ai/jobs/jobStream.ts`), the prompt bar's progress
// bar. Initiator only, decided before the stream opens (404 otherwise), so
// a refused EventSource fails with a plain HTTP error and the client polls
// `GET .../:jobId` instead. Headers as for the AI session stream.
export default defineApiHandler({
  access: allow.doc('write-content'),
  params: aiJobParams,
  handler: async ({ user, docAccess, params }) => {
    const { job } = await getJobReport(docAccess, params.jobId, 0)
    if (job.initiatorUserId !== user.id) throw apiError('ai/job-not-found')
    const body = createJobEventStream({
      jobId: job.id,
      read: () => getJobProgress(job.id),
      subscribe: listener => subscribeJobProgress(job.id, listener)
    })
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'private, no-cache, no-store, no-transform',
        'X-Accel-Buffering': 'no'
      }
    })
  }
})
