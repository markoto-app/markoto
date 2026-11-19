import { revertJob } from '../../../../../utils/ai/jobs/engine'
import { aiJobActionBody, aiJobParams } from '~~/shared/api/ai'

// POST /api/docs/:docId/ai-jobs/:jobId/revert: "Undo job" (Activity Log,
// prompt bar). Restores every part the job wrote that nobody changed since
// and leaves the rest; a running job is cancelled first. Corrections the
// job's own AI session made to its parts afterwards are undone with it
// (`followUps`); parts anybody else changed are kept and listed (`kept`). Anyone who may edit
// the document: it only puts back text the job replaced and never touches
// later edits. Logs one `ai.job.reverted` activity row and an audit row.
export default defineApiHandler({
  access: allow.doc('write-content'),
  params: aiJobParams,
  body: aiJobActionBody,
  handler: async ({ event, docAccess, params }) => {
    const result = await revertJob(docAccess, params.jobId, getClientIp(event))
    return {
      reverted: result.reverted,
      followUps: result.followUps,
      skipped: result.skipped.length,
      kept: result.skipped.map(s => ({ headingPath: s.headingPath, kind: s.kind }))
    }
  }
})
