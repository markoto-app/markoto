import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { nanoid } from 'nanoid'
import { countImportJobsSince, createImportJob, type NewImportItem } from '../../repos/imports'
import { getFolder } from '../../repos/folders'
import type { UserScope } from '../../repos/proofs'
import { proveScope } from '../access/folderProof'
import { capsFor, planLimitError, resolveUserPlan } from '../billing/entitlements'
import { apiError } from '../api/apiError'
import { useEnv } from '~~/shared/env/load'
import { DAY_MS, HOUR_SECONDS, MIB } from '~~/shared/config/units'
import { classifyImportFile, IMPORT_FILE_MAX_BYTES } from '~~/shared/config/imports'
import { isIgnoredImportPath, normalizeImportPath } from '~~/shared/utils/documents/importPaths'
import { parseGithubImportUrl } from './github'

// Starting a bulk import. Every limit is checked here, before anything is
// uploaded: the target (a workspace where the caller is admin or editor, or
// their personal documents; a folder of that scope), one active import per
// user, imports per day, and the plan's files and bytes per import. The
// browser then puts each file to its own presigned staging key and calls
// `start`; the worker re-checks what it actually reads.

/** Presigned PUTs stay valid this long: a large upload over a slow line takes a while. */
const PUT_TTL_SECONDS = HOUR_SECONDS
/** Skipped files listed in the result (beyond that they are only counted). */
const MAX_SKIPPED_LISTED = 500

export interface ImportTarget { workspaceId: string | null, folderId: string | null }

async function checkTargetAndQuota(self: UserScope, target: ImportTarget) {
  const scope = await proveScope(self.userId, target.workspaceId, 'editor')
  if (!scope) throw apiError(target.workspaceId === null ? 'auth/forbidden' : 'workspace/role-required')
  if (target.folderId !== null && !(await getFolder(scope.scope, target.folderId))) throw apiError('folder/not-found')
  const plan = await resolveUserPlan(self.userId)
  const caps = capsFor(plan)
  const today = await countImportJobsSince(self, new Date(Date.now() - DAY_MS))
  if (today >= caps.importJobsPerDay) {
    throw planLimitError(plan, 'importJobsPerDay', caps.importJobsPerDay, `You can start ${caps.importJobsPerDay} imports per day.`)
  }
  return { plan, caps }
}

function storageKey(jobId: string, itemId: string): string {
  return `imports/${jobId}/${itemId}`
}

/** Whether a listed file is taken, and as what; `skip` says why not. */
function triageFile(path: string, size: number, importMaxBytes: number): { kind: 'doc' | 'image' | 'archive' } | { skip: 'too-large' | 'unsupported' } {
  const cls = classifyImportFile(path)
  if (cls === 'other' || isIgnoredImportPath(path) || size === 0) return { skip: 'unsupported' }
  if (size > IMPORT_FILE_MAX_BYTES[cls] || (cls === 'converted' && size > importMaxBytes)) return { skip: 'too-large' }
  return { kind: cls === 'image' ? 'image' : cls === 'archive' ? 'archive' : 'doc' }
}

/** The job's items from the manifest: files to upload, and skipped ones (listed up to a limit). */
function planItems(jobId: string, files: ReadonlyArray<{ path: string, size: number }>, importMaxBytes: number) {
  const items: NewImportItem[] = []
  const seen = new Set<string>()
  let skipped = 0
  let counted = 0
  let bytes = 0
  for (const f of files) {
    const path = normalizeImportPath(f.path)
    if (!path) throw apiError('import/path-invalid')
    if (seen.has(path.toLowerCase())) continue
    seen.add(path.toLowerCase())
    const triage = triageFile(path, f.size, importMaxBytes)
    if ('skip' in triage) {
      skipped++
      if (skipped <= MAX_SKIPPED_LISTED) items.push({ itemId: nanoid(12), relativePath: path, kind: 'doc', s3Key: null, sizeBytes: f.size, status: 'skipped', reason: triage.skip })
      continue
    }
    counted++
    bytes += f.size
    const itemId = nanoid(12)
    items.push({ itemId, relativePath: path, kind: triage.kind, s3Key: storageKey(jobId, itemId), sizeBytes: f.size })
  }
  return { items, skipped, counted, bytes }
}

/** An upload job: the manifest of files the browser is about to put. */
export async function createUploadImportJob(self: UserScope, target: ImportTarget, files: ReadonlyArray<{ path: string, size: number }>) {
  const { plan, caps } = await checkTargetAndQuota(self, target)
  const jobId = nanoid(12)
  const { items, skipped, counted, bytes } = planItems(jobId, files, caps.importMaxBytes)
  if (counted === 0) throw apiError('import/nothing-to-import')
  if (counted > caps.importFilesPerJob) {
    throw planLimitError(plan, 'importFilesPerJob', caps.importFilesPerJob, `One import can bring in ${caps.importFilesPerJob} files.`)
  }
  if (bytes > caps.importBytesPerJob) {
    throw planLimitError(plan, 'importBytesPerJob', caps.importBytesPerJob, `One import can bring in ${Math.floor(caps.importBytesPerJob / MIB)} MB.`)
  }

  const job = await createImportJob(self, {
    jobId,
    workspaceId: target.workspaceId,
    targetFolderId: target.folderId,
    source: 'upload',
    sourceRef: null,
    status: 'uploading',
    total: items.filter(i => i.kind === 'doc' && i.status !== 'skipped').length,
    skipped,
    totalBytes: bytes,
    items
  })
  if (!job) throw apiError('import/job-active')

  const env = useEnv()
  const s3 = usePresignS3Client()
  const uploads = await Promise.all(items.filter(i => i.s3Key !== null).map(async i => ({
    itemId: i.itemId,
    path: i.relativePath,
    url: await getSignedUrl(s3, new PutObjectCommand({
      Bucket: env.storage.bucket,
      Key: i.s3Key as string,
      ContentType: 'application/octet-stream',
      ContentLength: i.sizeBytes
    }), { expiresIn: PUT_TTL_SECONDS, signableHeaders: new Set(['content-type']) })
  })))
  return { jobId, uploads, skipped }
}

/** A GitHub job: queued at once, the worker downloads the repository. */
export async function createGithubImportJob(self: UserScope, target: ImportTarget, url: string) {
  const parsed = parseGithubImportUrl(url)
  if (!parsed) throw apiError('import/github-url-invalid')
  await checkTargetAndQuota(self, target)
  const jobId = nanoid(12)
  const job = await createImportJob(self, {
    jobId,
    workspaceId: target.workspaceId,
    targetFolderId: target.folderId,
    source: 'github',
    sourceRef: parsed.canonicalUrl,
    status: 'queued',
    total: 0,
    skipped: 0,
    totalBytes: 0,
    items: []
  })
  if (!job) throw apiError('import/job-active')
  return { jobId }
}
