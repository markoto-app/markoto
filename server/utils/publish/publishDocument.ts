import { must } from '~~/shared/utils/must'
import { CopyObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { customAlphabet, nanoid } from 'nanoid'
import { listConfirmedUploadKeys } from '../../repos/uploads'
import type { DocAccess } from '../../repos/proofs'
import { renderWebSnapshot, type WebSnapshot } from '../rendering/renderClient'
import { listBrandAssetsForDoc } from '../../repos/brandAssets'
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
  /** The manage proof of the document being published. */
  doc: DocAccess<'manage'>
  title: string
  userId: number
  slug?: string
  indexable?: boolean
}

async function renderOrFail(doc: DocAccess<'manage'>): Promise<WebSnapshot> {
  const docId = doc.docId
  try {
    return await renderWebSnapshot(doc)
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.includes('413') || msg.includes('too large')) {
      throw createError({ statusCode: 413, message: 'This document is too large to publish as a web page.', data: { code: PUBLISH_ERROR_CODES.tooLarge } })
    }
    log.warn('web snapshot failed', { docId, err: e })
    throw createError({ statusCode: 502, message: 'The page could not be rendered. Please try again.', data: { code: PUBLISH_ERROR_CODES.renderFailed } })
  }
}

/** S3 keys of the document's workspace's brand files among `files`. */
async function brandKeys(doc: DocAccess<'view'>, files: Set<string>): Promise<Map<string, string>> {
  if (files.size === 0) return new Map()
  const out = new Map<string, string>()
  for (const row of await listBrandAssetsForDoc(doc)) {
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

async function freeSlug(title: string, doc: DocAccess<'manage'>): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const slug = slugFromTitle(title, slugSuffix())
    if (!await isSlugTaken(doc, slug)) return slug
  }
  return `page-${slugSuffix()}${slugSuffix()}`
}

export async function slugConflict(doc: DocAccess<'manage'>, slug: string): Promise<void> {
  if (await isSlugTaken(doc, slug)) {
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
  return withPublishLock(input.doc.docId, () => publishLocked(input))
}

async function publishLocked(input: PublishInput): Promise<PublishedPageSummary> {
  const { doc } = input
  const docId = doc.docId
  if (input.slug) await slugConflict(doc, input.slug)
  const snap = await renderOrFail(doc)
  // A render takes seconds; a moderator may have restricted the document meanwhile.
  if (await getModerationRestriction(doc)) throw moderationRestrictedError()

  const existing = await getPublishedPageSummary(doc)
  const pageId = existing?.id ?? nanoid(16)

  const texts = [sanitizeSnapshotHtml(snap.html), snap.css, snap.fontsImport]
  const refs = collectSnapshotAssets(texts, docId)
  const copied: SnapshotAssetRefs = { files: new Set(), brand: new Set() }
  await copyAll(pageId, 'files', await listConfirmedUploadKeys(doc, [...refs.files]), copied.files)
  await copyAll(pageId, 'brand', await brandKeys(doc, refs.brand), copied.brand)
  const [html, css, fontsImport] = texts.map(t => rewriteSnapshotAssets(t, docId, pageId, copied)) as [string, string, string]

  if (html.length + css.length + fontsImport.length > PUBLISH_MAX_SNAPSHOT_CHARS) {
    // The live page (if any) keeps its files; a first publish leaves nothing.
    if (!existing) await prunePublishedObjects(pageId)
    throw createError({ statusCode: 413, message: 'This document is too large to publish as a web page.', data: { code: PUBLISH_ERROR_CODES.tooLarge } })
  }

  const stored: StoredSnapshot = {
    title: input.title.slice(0, 255),
    language: snap.language.slice(0, 35) || 'en',
    html,
    css,
    fontsImport,
    hljsUrl: hljsUrlFor(snap.hljsTheme)
  }
  if (existing) await replaceSnapshot(input, pageId, stored)
  else await insertFirstSnapshot(input, pageId, stored)
  await prunePublishedObjects(pageId, keysOf(pageId, copied))
  return must(await getPublishedPageSummary(doc), 'published page just stored')
}

interface StoredSnapshot {
  title: string
  language: string
  html: string
  css: string
  fontsImport: string
  hljsUrl: ReturnType<typeof hljsUrlFor>
}

/** Republish: the page row gets the new snapshot (and slug / indexing when given). */
async function replaceSnapshot(input: PublishInput, pageId: string, stored: StoredSnapshot): Promise<void> {
  let updated: boolean
  try {
    // The slug was checked before the render; another page may have taken it since.
    updated = await updatePublishedSnapshot(input.doc, { ...stored, slug: input.slug, indexable: input.indexable, publishedByUserId: input.userId })
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
}

/** First publish: a new page row under the requested (or a free) slug. */
async function insertFirstSnapshot(input: PublishInput, pageId: string, stored: StoredSnapshot): Promise<void> {
  const slug = input.slug ?? await freeSlug(input.title, input.doc)
  try {
    await insertPublishedPage(input.doc, { ...stored, id: pageId, slug, indexable: input.indexable ?? false, publishedByUserId: input.userId })
  } catch (e) {
    await prunePublishedObjects(pageId)
    // Unique violation: the slug was taken in between, or a concurrent
    // first publish of the same document won.
    if (isUniqueViolation(e)) throw slugTakenError()
    throw e
  }
}

function keysOf(pageId: string, copied: SnapshotAssetRefs): Set<string> {
  return new Set([
    ...[...copied.files].map(f => publishedObjectKey(pageId, 'files', f)),
    ...[...copied.brand].map(f => publishedObjectKey(pageId, 'brand', f))
  ])
}
