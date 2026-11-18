import { queueImportJob } from '../../../repos/imports'
import { importJobParams } from '~~/shared/api/imports'
import { kickImportWorker } from '../../../utils/imports/importKick'

// The browser has put its files: queue the job for the worker. Files that
// did not arrive are reported as "not uploaded" by the worker.
export default defineApiHandler({
  access: allow.user(),
  params: importJobParams,
  body: 'none',
  handler: async ({ self, params }) => {
    if (!(await queueImportJob(self, params.jobId))) throw apiError('import/job-not-uploading')
    kickImportWorker()
    return { success: true }
  }
})
