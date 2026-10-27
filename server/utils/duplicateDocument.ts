import { CopyObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import * as Sentry from '@sentry/nuxt'
import {
  getDoc,
  insertDuplicateDoc,
  deleteDocRow
} from '../repos/documents'
import {
  listConfirmedUploadsForDoc,
  insertConfirmedUploads,
  deleteUploadsForDoc
} from '../repos/uploads'
import { cloneYjsStateWithUrlRewrite } from './cloneYjsState'
import { withThemeDocId } from '~~/shared/utils/customCss'
import { withThemeImagesDocId } from '~~/shared/utils/themeImages'
import { isValidTheme } from '~~/shared/utils/themeValidation'

// Duplicate a document end-to-end: DB row + Y.js state (with image URL
// rewrite) + S3 image assets.
//
// Ordering:
//   1. Insert the new documents row — allocates the target docId and
//      provides a valid FK target for upload rows.
//   2. S3 CopyObject each confirmed image to the new prefix
//      `docs/{targetDocId}/{fileId}` — same fileId on both sides so
//      ytext's `/api/files/{docId}/{fileId}` URLs resolve once we
//      rewrite the docId segment in the next step.
//   3. Clone Y.js state with URL rewrite (see `cloneYjsStateWithUrlRewrite`).
//
// Rollback: if any phase throws, undo the documents + uploads rows so
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
}

export interface DuplicateDeps {
  s3: Pick<S3Client, 'send'>
  bucket: string
}

export async function duplicateDocument(
  input: DuplicateInput,
  deps: DuplicateDeps
): Promise<void> {
  const source = await getDoc(input.sourceDocId)
  if (!source) {
    throw new Error(`Source document ${input.sourceDocId} not found`)
  }

  // Phase 1: documents row. Description/audience/language/templateId
  // copy through unchanged — a duplicate is the same document content
  // by another name, so its writing register and audience guidance
  // should match the source.
  await insertDuplicateDoc({
    newDocId: input.newDocId,
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    title: input.title,
    accessMode: source.accessMode,
    // Only a password-protected source carries its hash over; a hash
    // left on a doc in another mode is dead state and must not travel.
    passwordHash: source.accessMode === 'password-protected' ? source.passwordHash : null,
    // Custom CSS and theme images may reference the source's uploads;
    // point them at the copies (same fileIds, new docId) like the
    // markdown body rewrite.
    theme: source.theme ? withThemeUploadsDocId(source.theme, input.sourceDocId, input.newDocId) : source.theme,
    wordCount: source.wordCount,
    sizeBytes: source.sizeBytes,
    description: source.description,
    audience: source.audience,
    language: source.language,
    templateId: source.templateId
  })

  try {
    // Phase 2: S3 image asset clone. Uses the same fileId on both
    // sides so the rewritten markdown URLs match.
    const uploadsToClone = await listConfirmedUploadsForDoc(input.sourceDocId)
    const copiedRows: Parameters<typeof insertConfirmedUploads>[0] = []
    for (const row of uploadsToClone) {
      const newS3Key = `docs/${input.newDocId}/${row.fileId}`
      await deps.s3.send(new CopyObjectCommand({
        Bucket: deps.bucket,
        // CopySource must include the bucket and be URL-encoded per
        // S3's spec. Our fileIds are nanoid-safe so the only thing
        // needing encoding is the slash separators — which S3 actually
        // wants as literal slashes, so we encode the path segments.
        CopySource: `/${deps.bucket}/${row.s3Key}`,
        Key: newS3Key
      }))
      copiedRows.push({
        docId: input.newDocId,
        fileId: row.fileId,
        uploaderId: row.uploaderId,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        s3Key: newS3Key
      })
    }
    if (copiedRows.length > 0) {
      await insertConfirmedUploads(copiedRows)
    }

    // Phase 3: Y.js state with URL rewrite.
    await cloneYjsStateWithUrlRewrite(input.sourceDocId, input.newDocId)
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

/** Custom CSS always; theme images only on a well-formed theme (legacy partial rows are copied as they are). */
function withThemeUploadsDocId<T extends { customCss?: string }>(theme: T, sourceDocId: string, targetDocId: string): T {
  const cssMoved = withThemeDocId(theme, sourceDocId, targetDocId)
  return isValidTheme(cssMoved) ? withThemeImagesDocId(cssMoved, sourceDocId, targetDocId) : cssMoved
}
