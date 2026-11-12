import { CopyObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import * as Sentry from '@sentry/nuxt'
import {
  getDoc,
  insertDuplicateDoc,
  deleteDocRow
} from '../../repos/documents'
import {
  listConfirmedUploadsForDoc,
  insertConfirmedUploads,
  insertConfirmedUploadsWithinQuota,
  deleteUploadsForDoc,
  sumImageBytesInScope
} from '../../repos/uploads'
import { imageQuotaMessage, type ImageQuota } from '../storage/imageQuota'
import { cloneYjsStateWithUrlRewrite } from './cloneYjsState'
import { withThemeDocId } from '~~/shared/utils/theme/customCss'
import { withThemeImagesDocId } from '~~/shared/utils/theme/themeImages'
import { isValidTheme } from '~~/shared/utils/theme/themeValidation'

// Duplicate a document end-to-end: DB row + Y.js state (with image URL
// rewrite) + S3 image assets.
//
// Ordering:
//   1. Insert the new documents row (FK target for the upload rows).
//   2. S3 CopyObject each confirmed image to `docs/{targetDocId}/{fileId}`;
//      the fileId stays the same so the rewritten ytext URLs resolve.
//   3. Clone Y.js state with URL rewrite (`cloneYjsStateWithUrlRewrite`).
//
// Rollback: if any step throws, undo the documents + uploads rows so
// the duplicate never becomes visible. Stray S3 objects are caught by
// the orphan-cleanup sweep (whole prefix goes away once the documents
// row is absent).
//
// Authorization: NOT checked here — caller must verify canEditDoc on
// source + admin/editor on target workspace (if specified).

export interface DuplicateInput {
  sourceDocId: string
  newDocId: string
  ownerId: number | null
  workspaceId: string | null
  title: string
  /**
   * A new document made from a workspace template: it starts
   * private (never the template document's sharing or password) and its
   * live title (ymeta) is `title`, not the template document's.
   */
  fromTemplate?: boolean
}

export interface DuplicateDeps {
  s3: Pick<S3Client, 'send'>
  bucket: string
  /**
   * The quota the copies count against (`resolveImageQuota(ownerId, null,
   * targetWorkspaceId)`): the target Team / Business workspace's pool, else
   * the duplicator's personal quota. The copied images are attributed to
   * the duplicator — not the original uploaders, whose quota a stranger
   * could otherwise fill by duplicating their open doc.
   */
  imageQuota: ImageQuota
}

/** The copies would push the duplicator over their image storage quota. */
export class ImageQuotaExceededError extends Error {
  readonly limitBytes: number
  constructor(limitBytes: number) {
    super(imageQuotaMessage(limitBytes))
    this.name = 'ImageQuotaExceededError'
    this.limitBytes = limitBytes
  }
}

export async function duplicateDocument(
  input: DuplicateInput,
  deps: DuplicateDeps
): Promise<void> {
  const source = await getDoc(input.sourceDocId)
  if (!source) {
    throw new Error(`Source document ${input.sourceDocId} not found`)
  }

  // Cheap quota pre-check before anything is written or copied. The
  // authoritative check is the atomic insert in step 2.
  const uploadsToClone = await listConfirmedUploadsForDoc(input.sourceDocId)
  const cloneBytes = uploadsToClone.reduce((n, r) => n + r.sizeBytes, 0)
  if (input.ownerId !== null && cloneBytes > 0
    && await sumImageBytesInScope(deps.imageQuota.scope) + cloneBytes > deps.imageQuota.maxBytes) {
    throw new ImageQuotaExceededError(deps.imageQuota.maxBytes)
  }

  // Step 1: documents row. Description/audience/language/templateId
  // copy through unchanged — a duplicate is the same document content
  // by another name, so its writing register and audience guidance
  // should match the source.
  await insertDuplicateDoc({
    newDocId: input.newDocId,
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    title: input.title,
    accessMode: input.fromTemplate ? 'private' : source.accessMode,
    // Only a password-protected source carries its hash over; a hash
    // left on a doc in another mode is dead state and must not travel.
    passwordHash: !input.fromTemplate && source.accessMode === 'password-protected' ? source.passwordHash : null,
    // Custom CSS and theme images may reference the source's uploads;
    // point them at the copies (same fileIds, new docId) like the
    // markdown body rewrite.
    theme: source.theme ? withThemeUploadsDocId(source.theme, input.sourceDocId, input.newDocId) : source.theme,
    wordCount: source.wordCount,
    sizeBytes: source.sizeBytes,
    description: source.description,
    audience: source.audience,
    language: source.language,
    templateId: source.templateId,
    // The copy is the same content: a moderation restriction travels with
    // it, or duplicating would undo the decision.
    moderationRestrictedAt: source.moderationRestrictedAt,
    moderationReportId: source.moderationReportId
  })

  try {
    // Step 2: S3 image asset clone.
    await cloneUploads(input, deps, uploadsToClone)

    // Step 3: Y.js state with URL rewrite.
    await cloneYjsStateWithUrlRewrite(input.sourceDocId, input.newDocId, input.fromTemplate ? { title: input.title } : undefined)
  } catch (e) {
    // Roll back the DB side. Stray S3 objects under the new prefix
    // will be caught by the orphan-cleanup sweep once the documents
    // row is gone.
    try {
      await deleteUploadsForDoc(input.newDocId)
      await deleteDocRow(input.newDocId)
    } catch (rollbackErr) {
      Sentry.captureException(rollbackErr, {
        tags: { component: 'duplicateDocument', event: 'rollback_failed', docId: input.newDocId }
      })
    }
    throw e
  }
}

/**
 * Copy the source's confirmed uploads to the new document and record them
 * (against the duplicator's image quota). Uses the same fileId on both
 * sides so the rewritten markdown URLs match.
 */
async function cloneUploads(
  input: DuplicateInput,
  deps: DuplicateDeps,
  uploadsToClone: Awaited<ReturnType<typeof listConfirmedUploadsForDoc>>
): Promise<void> {
  const copiedRows: Parameters<typeof insertConfirmedUploads>[0] = []
  for (const row of uploadsToClone) {
    const newS3Key = `docs/${input.newDocId}/${row.fileId}`
    await deps.s3.send(new CopyObjectCommand({
      Bucket: deps.bucket,
      // CopySource must include the bucket. Keys are nanoid-safe, so no
      // URL-encoding is needed.
      CopySource: `/${deps.bucket}/${row.s3Key}`,
      Key: newS3Key
    }))
    copiedRows.push({
      docId: input.newDocId,
      fileId: row.fileId,
      uploaderId: input.ownerId ?? row.uploaderId,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      s3Key: newS3Key
    })
  }
  if (copiedRows.length > 0 && input.ownerId !== null) {
    const res = await insertConfirmedUploadsWithinQuota(copiedRows, deps.imageQuota.maxBytes, deps.imageQuota.scope)
    if (!res.reserved) throw new ImageQuotaExceededError(deps.imageQuota.maxBytes)
  } else if (copiedRows.length > 0) {
    await insertConfirmedUploads(copiedRows)
  }
}

/** Custom CSS always; theme images only on a well-formed theme (partial rows are copied as they are). */
function withThemeUploadsDocId<T extends { customCss?: string }>(theme: T, sourceDocId: string, targetDocId: string): T {
  const cssMoved = withThemeDocId(theme, sourceDocId, targetDocId)
  return isValidTheme(cssMoved) ? withThemeImagesDocId(cssMoved, sourceDocId, targetDocId) : cssMoved
}
