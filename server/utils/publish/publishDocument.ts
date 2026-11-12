import { CopyObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { customAlphabet, nanoid } from 'nanoid'
import { uploads } from '../../db/schema'
import { useDatabase } from '../platform/database'
import { renderWebSnapshot, type WebSnapshot } from '../rendering/renderClient'
import { listBrandAssets } from '../../repos/brandAssets'
import { getModerationRestriction } from '../../repos/documents'
import { moderationRestrictedError } from '../privacy/moderationRestriction'
import {
  getPublishedPageSummary, insertPublishedPage, isSlugTaken, updatePublishedSnapshot,
  type PublishedPageSummary
} from '../../repos/publishedPages'
import { HLJS_THEMES, hljsTheme } from '~~/shared/utils/vendor/hljsAssets'
import { PUBLISH_ERROR_CODES, PUBLISH_MAX_SNAPSHOT_CHARS, slugFromTitle } from '~~/shared/config/publish'
import { sanitizeSnapshotHtml } from './sanitizeSnapshot'
import { collectSnapshotAssets, publishedObjectKey, publishedPrefix, rewriteSnapshotAssets, type SnapshotAssetRefs } from './snapshotAssets'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../platform/logger'

const log = useLogger('publish')

// Publish a document as a web page: render the web snapshot, copy
// the files it shows to the page's own prefix, store it. Re-publishing
// keeps the page id and slug (unless a new slug is asked for) and
// replaces the snapshot and its files.

const slugSuffix = customAlphabet('abcdefghijkmnpqrstuvwxyz23456789', 6)

export interface PublishInput {
  docId: string
  workspaceId: string | null
  title: string
  userId: number
  slug?: string
  indexable?: boolean
}

async function renderOrFail(docId: string): Promise<WebSnapshot> {
  try {
    return await renderWebSnapshot(docId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.includes('413') || msg.includes('too large')) {
      throw createError({ statusCode: 413, message: 'This document is too large to publish as a web page.', data: { code: PUBLISH_ERROR_CODES.tooLarge } })
    }
    log.warn('web snapshot failed', { docId, err: e })
    throw createError({ statusCode: 502, message: 'The page could not be rendered. Please try again.', data: { code: PUBLISH_ERROR_CODES.renderFailed } })
  }
}

/** S3 keys of the document's confirmed uploads among `files`. */
async function uploadKeys(docId: string, files: Set<string>): Promise<Map<string, string>> {
  if (files.size === 0) return new Map()
  const rows = await useDatabase().select({ fileId: uploads.fileId, s3Key: uploads.s3Key }).from(uploads)
    .where(and(eq(uploads.docId, docId), inArray(uploads.fileId, [...files]), isNotNull(uploads.confirmedAt)))
  return new Map(rows.map(r => [r.fileId, r.s3Key]))
}

/** S3 keys of the workspace's brand files among `files`. */
async function brandKeys(workspaceId: string | null, files: Set<string>): Promise<Map<string, string>> {
  if (!workspaceId || files.size === 0) return new Map()
  const out = new Map<string, string>()
  for (const row of await listBrandAssets(workspaceId)) {
    const file = `${row.id}.${row.format}`
    if (files.has(file)) out.set(file, row.s3Key)
  }
  return out
}

async function copyAll(pageId: string, kind: 'files' | 'brand', sources: Map<string, string>, copied: Set<string>): Promise<void> {
  const s3 = useS3Client()
  const bucket = useEnv().storage.bucket
  for (const [file, key] of sources) {
    try {
      await s3.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `/${bucket}/${key}`, Key: publishedObjectKey(pageId, kind, file) }))
      copied.add(file)
    } catch (e) {
      // A missing source (deleted by the GC meanwhile) leaves its URL as it
      // was — the page shows a broken image rather than failing to publish.
      log.warn('copying a file of the page failed', { pageId, kind, file, err: e })
    }
  }
}

/** Delete the page's objects that the new snapshot no longer uses (or all of them). */
export async function prunePublishedObjects(pageId: string, keep: ReadonlySet<string> = new Set()): Promise<void> {
  const s3 = useS3Client()
  const bucket = useEnv().storage.bucket
  try {
    const stale: { Key: string }[] = []
    let token: string | undefined
    do {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: publishedPrefix(pageId), ContinuationToken: token }))
      for (const o of list.Contents ?? []) if (o.Key && !keep.has(o.Key)) stale.push({ Key: o.Key })
      token = list.IsTruncated ? list.NextContinuationToken : undefined
    } while (token)
    for (let i = 0; i < stale.length; i += 1000) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: stale.slice(i, i + 1000), Quiet: true } }))
    }
  } catch (e) {
    // No bucket yet (a fresh stack before its first upload): nothing to prune.
    if ((e as { name?: string }).name === 'NoSuchBucket') return
    // The orphan sweep removes prefixes of deleted pages; stale files of a
    // live page are harmless (nothing links to them).
    log.warn('pruning objects of the page failed', { pageId, err: e })
  }
}

function hljsUrlFor(name: string): string | null {
  return Object.hasOwn(HLJS_THEMES, name) ? hljsTheme(name as keyof typeof HLJS_THEMES).url : null
}

async function freeSlug(title: string, docId: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const slug = slugFromTitle(title, slugSuffix())
    if (!await isSlugTaken(slug, docId)) return slug
  }
  return `page-${slugSuffix()}${slugSuffix()}`
}

export async function slugConflict(slug: string, docId: string): Promise<void> {
  if (await isSlugTaken(slug, docId)) {
    throw createError({ statusCode: 409, message: 'This address is already taken. Choose another one.', data: { code: PUBLISH_ERROR_CODES.slugTaken } })
  }
}

const PUBLISH_LOCK = 'publish-doc'
// Longer than a render (90 s) plus copying the files.
const PUBLISH_LOCK_TTL_MS = 180_000

/**
 * Run `fn` while holding the document's publish lock, so a publish and an
 * unpublish (or two publishes) of one document never interleave: each
 * prunes the page's files against its own snapshot. Held → 409.
 */
export async function withPublishLock<T>(docId: string, fn: () => Promise<T>): Promise<T> {
  if (!await tryAcquireSessionLock(PUBLISH_LOCK, docId, PUBLISH_LOCK_TTL_MS)) {
    throw createError({ statusCode: 409, message: 'This page is being updated. Try again in a moment.', data: { code: PUBLISH_ERROR_CODES.busy } })
  }
  try {
    return await fn()
  } finally {
    await releaseSessionLock(PUBLISH_LOCK, docId)
  }
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505'
}

const slugTakenError = () => createError({ statusCode: 409, message: 'This address is already taken. Choose another one.', data: { code: PUBLISH_ERROR_CODES.slugTaken } })

export async function publishDocument(input: PublishInput): Promise<PublishedPageSummary> {
  return withPublishLock(input.docId, () => publishLocked(input))
}

async function publishLocked(input: PublishInput): Promise<PublishedPageSummary> {
  const { docId } = input
  if (input.slug) await slugConflict(input.slug, docId)
  const snap = await renderOrFail(docId)
  // A render takes seconds; a moderator may have restricted the document meanwhile.
  if (await getModerationRestriction(docId)) throw moderationRestrictedError()

  const existing = await getPublishedPageSummary(docId)
  const pageId = existing?.id ?? nanoid(16)

  const texts = [sanitizeSnapshotHtml(snap.html), snap.css, snap.fontsImport]
  const refs = collectSnapshotAssets(texts, docId)
  const copied: SnapshotAssetRefs = { files: new Set(), brand: new Set() }
  await copyAll(pageId, 'files', await uploadKeys(docId, refs.files), copied.files)
  await copyAll(pageId, 'brand', await brandKeys(input.workspaceId, refs.brand), copied.brand)
  const [html, css, fontsImport] = texts.map(t => rewriteSnapshotAssets(t, docId, pageId, copied)) as [string, string, string]

  if (html.length + css.length + fontsImport.length > PUBLISH_MAX_SNAPSHOT_CHARS) {
    // The live page (if any) keeps its files; a first publish leaves nothing.
    if (!existing) await prunePublishedObjects(pageId)
    throw createError({ statusCode: 413, message: 'This document is too large to publish as a web page.', data: { code: PUBLISH_ERROR_CODES.tooLarge } })
  }

  const stored = {
    title: input.title.slice(0, 255),
    language: snap.language.slice(0, 35) || 'en',
    html,
    css,
    fontsImport,
    hljsUrl: hljsUrlFor(snap.hljsTheme)
  }
  if (existing) {
    let updated: boolean
    try {
      // The slug was checked before the render; another page may have taken it since.
      updated = await updatePublishedSnapshot(docId, { ...stored, slug: input.slug, indexable: input.indexable, publishedByUserId: input.userId })
    } catch (e) {
      // The live page keeps its files (extra copies go with the next publish).
      if (isUniqueViolation(e)) throw slugTakenError()
      throw e
    }
    if (!updated) {
      // Taken down while rendering (moderation): leave nothing behind.
      await prunePublishedObjects(pageId)
      throw createError({ statusCode: 409, message: 'This page was unpublished in the meantime.', data: { code: PUBLISH_ERROR_CODES.notPublished } })
    }
  } else {
    const slug = input.slug ?? await freeSlug(input.title, docId)
    try {
      await insertPublishedPage({ ...stored, id: pageId, docId, slug, indexable: input.indexable ?? false, publishedByUserId: input.userId })
    } catch (e) {
      await prunePublishedObjects(pageId)
      // Unique violation: the slug was taken in between, or a concurrent
      // first publish of the same document won.
      if (isUniqueViolation(e)) throw slugTakenError()
      throw e
    }
  }
  await prunePublishedObjects(pageId, keysOf(pageId, copied))
  return (await getPublishedPageSummary(docId))!
}

function keysOf(pageId: string, copied: SnapshotAssetRefs): Set<string> {
  return new Set([
    ...[...copied.files].map(f => publishedObjectKey(pageId, 'files', f)),
    ...[...copied.brand].map(f => publishedObjectKey(pageId, 'brand', f))
  ])
}
