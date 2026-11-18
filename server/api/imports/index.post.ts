import { createGithubImportJob, createUploadImportJob } from '../../utils/imports/createImportJob'
import { createImportBody } from '~~/shared/api/imports'
import { kickImportWorker } from '../../utils/imports/importKick'

// Start a bulk import into a workspace (admins and editors) or the caller's
// personal documents, optionally into a folder.
//   - `upload`: the browser lists the files (paths keep the folder
//     structure; a .zip counts as one file and is expanded by the worker),
//     gets one presigned PUT per file, uploads, then calls `start`;
//   - `github`: a public repository or a folder of one; queued at once.
// Every limit (plan files / bytes per import, imports per day, one at a
// time) is checked here, before anything is uploaded.
export default defineApiHandler({
  access: allow.user(),
  body: createImportBody,
  rateLimit: { namespace: 'import-jobs', max: 20, windowMs: 60 * 60_000, key: 'user' },
  handler: async ({ self, body }) => {
    const target = { workspaceId: body.workspaceId, folderId: body.folderId }
    if (body.source === 'github') {
      const job = await createGithubImportJob(self, target, body.url)
      kickImportWorker()
      return { ...job, uploads: [], skipped: 0 }
    }
    return createUploadImportJob(self, target, body.files)
  }
})
