import { cancelImportJob } from '../../../repos/imports'
import { importJobParams } from '~~/shared/api/imports'

// Stop an import. Not started yet: it ends now. Running: it stops after the
// file it is on. Documents already created stay (listed in the result).
export default defineApiHandler({
  access: allow.user(),
  params: importJobParams,
  handler: async ({ self, params }) => {
    const status = await cancelImportJob(self, params.jobId)
    if (status === null) throw apiError('import/job-not-found')
    return { success: true, status }
  }
})
