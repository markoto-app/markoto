import { readJob } from '../../../../utils/designImport/job'
import { designImportJobParams } from '~~/shared/api/brand'

/**
 * Progress + result of a design run started by `POST
 * /api/themes/from-document/start`. Only the user who started it may
 * read it (404 for anyone else, the same as an unknown id). The result
 * carries the proposed theme, a name + description suggestion and page
 * pictures (ours, and the original's for a PDF) for the side-by-side
 * preview. Nothing is saved until the user saves it via `/api/themes`.
 */
export default defineApiHandler({
  access: allow.user(),
  params: designImportJobParams,
  handler: async ({ event, user, params: { jobId } }) => {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(jobId)) throw apiError('resource/not-found')
    const job = await readJob(jobId, user.id)
    if (!job) throw apiError('resource/not-found')
    setResponseHeader(event, 'Cache-Control', 'private, no-store')
    const { userId: _userId, ...view } = job
    return view
  }
})
