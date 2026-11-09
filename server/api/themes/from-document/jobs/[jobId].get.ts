import { readJob } from '../../../../utils/designImport/job'

/**
 * Progress + result of a design run started by `POST
 * /api/themes/from-document/start`. Only the user who started it may
 * read it (404 for anyone else, the same as an unknown id). The result
 * carries the proposed theme, a name + description suggestion and page
 * pictures (ours, and the original's for a PDF) for the side-by-side
 * preview. Nothing is saved until the user saves it via `/api/themes`.
 */
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const jobId = getRouterParam(event, 'jobId') ?? ''
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(jobId)) throw createError({ statusCode: 404, message: 'Not found' })
  const job = await readJob(jobId, session.user.id)
  if (!job) throw createError({ statusCode: 404, message: 'Not found' })
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  const { userId: _userId, ...view } = job
  return view
})
