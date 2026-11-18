import { GetObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import {
  addJobItems,
  claimQueuedImportJob,
  finishImportJob,
  finishJobItem,
  getImportJobForWorker,
  importJobHeartbeat,
  listJobItems,
  refreshJobCounters,
  setJobItemPlan,
  type ImportItemRow,
  type ImportJobRow,
  type NewImportItem
} from '../../repos/imports'
import { ensureChildFolder } from '../../repos/folders'
import { docExists } from '../../repos/documents'
import { appendAuditEvent } from '../../repos/audit'
import { system } from '../../repos/proofs'
import { proveImportJobScope, type ImportJobProofs } from '../access/importProof'
import { capsFor, resolveUserPlan } from '../billing/entitlements'
import { createDocument } from '../documents/createDocument'
import { seedDocContent } from '../documents/seedDocContent'
import { indexNewDocument } from '../documents/searchIndex'
import { deleteDocument } from '../documents/documentLifecycle'
import { s3ObjectStore } from '../storage/objectStore'
import { useLogger } from '../platform/logger'
import { attachImportImages } from './importImages'
import { collectMarkdownRefs } from './markdownRefs'
import { listArchive, extractArchiveEntries, ArchiveRejectedError, type ArchiveListing } from './archive'
import { downloadGithubZip, parseGithubImportUrl, GithubImportError } from './github'
import { convertWithMarkitdown, type ConvertedExtension } from './markitdownConvert'
import { useEnv } from '~~/shared/env/load'
import { classifyImportFile, importExtension, IMPORT_DOC_MAX_CHARS, IMPORT_FILE_MAX_BYTES, type ImportItemReason } from '~~/shared/config/imports'
import { importBaseName, importFolderChain, linkFragment, resolveImportLink } from '~~/shared/utils/documents/importPaths'
import { folderNameFromSegment } from '~~/shared/utils/documents/folderName'
import { splitMarkotoFrontmatter } from '~~/shared/utils/markdown/markdownFrontmatter'
import { DOC_TITLE_MAX_LENGTH } from '~~/shared/config/docCreate'

const log = useLogger('import-worker')

// The import worker: takes one queued job and turns its files into
// documents. Runs from the `import-worker` sweeper (server/plugins/), so one
// instance at a time works through the queue.
//
// For each job:
//   1. Re-check the importer may still write to the target (a role can have
//      changed since the job was created).
//   2. Expand archives (an uploaded .zip, the GitHub repository) into items,
//      within the job's file and byte budget.
//   3. Choose every document's id up front, so links between imported files
//      (`[see](../other.md)`) can point at `/d/<id>` before it exists.
//   4. Per file: read, convert (Markdown as it is, the other formats through
//      markitdown with their pictures), mirror its folders, create the
//      document, store its images (embedded and linked by relative path),
//      write its text and index it. A failed file is recorded and the job
//      goes on; the cancel flag is read between files.
//   5. Delete the uploaded staging files, count, audit.
//
// Idempotent per file: a job picked up again after a crash skips finished
// files and redoes a half-made document (it is deleted and created anew).

const by = system('import-worker')

/** Items addressed inside an archive: `archive:<archive item id, or 'github'>/<entry name>`. */
const ARCHIVE_PREFIX = 'archive:'
/** Byte-order mark some editors put at the start of a UTF-8 file. */
const BOM = '﻿'

function archiveRef(key: string | null): { source: string, name: string } | null {
  if (!key?.startsWith(ARCHIVE_PREFIX)) return null
  const rest = key.slice(ARCHIVE_PREFIX.length)
  const slash = rest.indexOf('/')
  return slash === -1 ? null : { source: rest.slice(0, slash), name: rest.slice(slash + 1) }
}

interface JobContext {
  job: ImportJobRow
  proofs: ImportJobProofs
  /** Archives held for this job, by archive item id ('github' for the repository). */
  archives: Map<string, Uint8Array>
  /** Lower-cased path -> item, for links between files. */
  byPath: Map<string, ImportItemRow>
  folders: Map<string, string | null>
  usedImages: Set<string>
  importMaxBytes: number
}

class ItemFailure extends Error {
  constructor(public readonly reason: ImportItemReason) {
    super(reason)
  }
}

async function readS3(key: string): Promise<Uint8Array | null> {
  try {
    const out = await useS3Client().send(new GetObjectCommand({ Bucket: useEnv().storage.bucket, Key: key }))
    return out.Body ? await out.Body.transformToByteArray() : null
  } catch {
    return null
  }
}

async function readItem(ctx: JobContext, item: ImportItemRow): Promise<Uint8Array | null> {
  if (!item.s3Key) return null
  const ref = archiveRef(item.s3Key)
  if (!ref) return readS3(item.s3Key)
  const archive = ctx.archives.get(ref.source)
  return archive ? extractArchiveEntries(archive, new Set([ref.name])).get(ref.name) ?? null : null
}

/** The folder a file's directories map to, created on first use below the job's target folder. */
async function folderFor(ctx: JobContext, path: string): Promise<string | null> {
  let parent: string | null = ctx.job.targetFolderId
  let key = ''
  for (const name of importFolderChain(path)) {
    key = `${key}/${name.toLowerCase()}`
    const cached = ctx.folders.get(key)
    if (cached === undefined) {
      parent = await ensureChildFolder(ctx.proofs.scope, parent, name, () => nanoid(12))
      ctx.folders.set(key, parent)
    } else {
      parent = cached
    }
  }
  return parent
}

/** The text of the first `# heading` line, if any. */
function firstHeading(markdown: string): string | null {
  for (const line of markdown.split('\n', 200)) {
    if (line.startsWith('# ')) {
      const text = line.slice(2).replaceAll('*', '').replaceAll('_', '').replaceAll('`', '').trim()
      if (text) return text
    }
  }
  return null
}

/** Title: markoto frontmatter, else the first `# heading`, else the file name. Returns the body without frontmatter. */
function titleAndBody(markdown: string, path: string): { title: string, body: string } {
  const split = splitMarkotoFrontmatter(markdown)
  const body = split.kind === 'markoto' ? split.body : markdown
  const fromFrontmatter = split.kind === 'markoto' && typeof split.data.title === 'string' ? split.data.title.trim() : ''
  const title = fromFrontmatter || firstHeading(body) || importBaseName(path)
  return { title: title.slice(0, DOC_TITLE_MAX_LENGTH), body }
}

async function markdownOf(ctx: JobContext, item: ImportItemRow, bytes: Uint8Array): Promise<string> {
  const cls = classifyImportFile(item.relativePath)
  if (cls === 'markdown') {
    if (bytes.byteLength > IMPORT_FILE_MAX_BYTES.markdown) throw new ItemFailure('too-large')
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return text.startsWith(BOM) ? text.slice(1) : text
    } catch {
      throw new ItemFailure('not-utf8')
    }
  }
  if (cls !== 'converted') throw new ItemFailure('unsupported')
  if (bytes.byteLength > Math.min(IMPORT_FILE_MAX_BYTES.converted, ctx.importMaxBytes)) throw new ItemFailure('too-large')
  try {
    return await convertWithMarkitdown(bytes, importExtension(item.relativePath) as ConvertedExtension, { images: true })
  } catch {
    throw new ItemFailure('conversion-failed')
  }
}

/** Links to other files of this import, pointed at their documents. */
function crossLinks(ctx: JobContext, item: ImportItemRow, body: string): Map<string, string> {
  const links = new Map<string, string>()
  for (const target of collectMarkdownRefs(body).links) {
    const resolved = resolveImportLink(item.relativePath, target)
    const other = resolved ? ctx.byPath.get(resolved.toLowerCase()) : undefined
    if (other?.kind === 'doc' && other.plannedDocId && other.status !== 'skipped') {
      links.set(target, `/d/${other.plannedDocId}${linkFragment(target)}`)
    }
  }
  return links
}

async function importOne(ctx: JobContext, item: ImportItemRow): Promise<void> {
  const docId = item.plannedDocId as string
  const bytes = await readItem(ctx, item)
  if (!bytes) throw new ItemFailure(archiveRef(item.s3Key) ? 'unreadable' : 'not-uploaded')
  const { title, body } = titleAndBody(await markdownOf(ctx, item, bytes), item.relativePath)
  if (body.length > IMPORT_DOC_MAX_CHARS) throw new ItemFailure('too-long')

  // A document left half-made by an interrupted run is made again.
  if (await docExists(docId)) await deleteDocument(by.doc(docId))
  const folderId = await folderFor(ctx, item.relativePath)
  await createDocument({ owner: ctx.proofs.owner, docId, title, workspaceId: ctx.job.workspaceId, folderId })
  const doc = ctx.proofs.newDoc(docId)

  const result = await attachImportImages({
    doc,
    uploader: ctx.proofs.owner,
    markdown: body,
    links: crossLinks(ctx, item, body),
    readLinked: async (target) => {
      const resolved = resolveImportLink(item.relativePath, target)
      const image = resolved ? ctx.byPath.get(resolved.toLowerCase()) : undefined
      if (image?.kind !== 'image') return null
      ctx.usedImages.add(image.itemId)
      return readItem(ctx, image)
    }
  })
  const yjsId = await seedDocContent(doc, result.markdown)
  await indexNewDocument(doc, { title, body: result.markdown, yjsId })
  await finishJobItem(by, ctx.job.jobId, item.itemId, { status: 'done', docId, imagesSkipped: result.imagesSkipped })
}

interface ArchiveSource {
  id: string
  /** Folder the entries go into (an uploaded zip becomes a folder named after it). */
  prefix: string
  load: () => Promise<Uint8Array | null>
  opts: { stripPrefix?: boolean, under?: string }
  item?: ImportItemRow
}

function archiveSources(ctx: JobContext, items: ImportItemRow[]): ArchiveSource[] | 'github-url-invalid' {
  const sources: ArchiveSource[] = []
  if (ctx.job.source === 'github') {
    const ref = parseGithubImportUrl(ctx.job.sourceRef ?? '')
    if (!ref) return 'github-url-invalid'
    // Like an uploaded folder, the import lands in a folder named after what was imported.
    const name = folderNameFromSegment(ref.path?.split('/').at(-1) ?? ref.repo)
    sources.push({ id: 'github', prefix: `${name}/`, load: () => downloadGithubZip(ref), opts: { stripPrefix: true, under: ref.path ?? undefined } })
  }
  for (const item of items) {
    if (item.kind !== 'archive' || item.status === 'failed') continue
    const slash = item.relativePath.lastIndexOf('/')
    const dir = slash === -1 ? '' : item.relativePath.slice(0, slash + 1)
    sources.push({ id: item.itemId, prefix: `${dir}${importBaseName(item.relativePath)}/`, load: () => readItem(ctx, item), opts: {}, item })
  }
  return sources
}

function githubFailure(e: GithubImportError): string {
  if (e.reason === 'not-found') return 'github-not-found'
  return e.reason === 'too-large' ? 'archive-too-large' : 'github-unavailable'
}

/** The items an archive listing adds, within the job's file budget (null: over it). */
function itemsFromListing(source: ArchiveSource, listing: ArchiveListing, budget: { files: number }, used: { files: number }): NewImportItem[] | null {
  const added: NewImportItem[] = []
  for (const entry of listing.entries) {
    const cls = classifyImportFile(entry.path)
    if (cls === 'other' || cls === 'archive') continue
    if (used.files >= budget.files) return null
    used.files++
    added.push({
      itemId: nanoid(12),
      relativePath: `${source.prefix}${entry.path}`,
      kind: cls === 'image' ? 'image' : 'doc',
      s3Key: `${ARCHIVE_PREFIX}${source.id}/${entry.rawName}`,
      sizeBytes: entry.size
    })
  }
  return added
}

/** Load (and, the first time, expand) every archive of the job. Returns a job error code, or null. */
async function expandArchives(ctx: JobContext, items: ImportItemRow[], budget: { files: number, bytes: number }): Promise<string | null> {
  const loose = items.filter(i => i.kind !== 'archive' && i.status !== 'skipped')
  const used = { files: loose.length, bytes: loose.reduce((n, i) => n + i.sizeBytes, 0) }
  const expanded = new Set(items.map(i => archiveRef(i.s3Key)?.source).filter((x): x is string => !!x))
  const sources = archiveSources(ctx, items)
  if (typeof sources === 'string') return sources
  for (const source of sources) {
    const failure = await expandSource(ctx, source, { budget, used, expanded: expanded.has(source.id) })
    if (failure) return failure
  }
  return null
}

/** An archive's listing; a refused uploaded zip fails as one file (null), a refused repository fails the job (its code). */
async function listSource(ctx: JobContext, source: ArchiveSource, data: Uint8Array, maxExpandedBytes: number): Promise<ArchiveListing | string | null> {
  try {
    return listArchive(data, { maxExpandedBytes, ...source.opts })
  } catch (e) {
    if (!(e instanceof ArchiveRejectedError)) throw e
    if (!source.item) return e.reason === 'too-large' ? 'too-many-bytes' : 'archive-unreadable'
    await finishJobItem(by, ctx.job.jobId, source.item.itemId, { status: 'failed', reason: e.reason === 'too-large' ? 'too-large' : 'unreadable' })
    return null
  }
}

/** Load one archive (kept for the job) and add its entries as items the first time. */
async function expandSource(
  ctx: JobContext,
  source: ArchiveSource,
  state: { budget: { files: number, bytes: number }, used: { files: number, bytes: number }, expanded: boolean }
): Promise<string | null> {
  let data: Uint8Array | null
  try {
    data = await source.load()
  } catch (e) {
    if (e instanceof GithubImportError) return githubFailure(e)
    throw e
  }
  if (!data) {
    if (source.item) await finishJobItem(by, ctx.job.jobId, source.item.itemId, { status: 'failed', reason: 'not-uploaded' })
    return null
  }
  ctx.archives.set(source.id, data)
  if (state.expanded) return null
  const listing = await listSource(ctx, source, data, Math.max(0, state.budget.bytes - state.used.bytes))
  if (typeof listing === 'string') return listing
  if (listing === null) return null
  state.used.bytes += listing.expandedBytes
  const added = itemsFromListing(source, listing, state.budget, state.used)
  if (!added) return 'too-many-files'
  await addJobItems(by, ctx.job.jobId, added)
  if (source.item) await finishJobItem(by, ctx.job.jobId, source.item.itemId, { status: 'done' })
  return null
}

/** Give every document item its id (once) and index the items by path. */
async function planDocuments(ctx: JobContext): Promise<ImportItemRow[]> {
  const items = await listJobItems(by, ctx.job.jobId)
  for (const item of items) {
    if (item.kind === 'doc' && item.status === 'pending' && !item.plannedDocId) {
      item.plannedDocId = nanoid(10)
      await setJobItemPlan(by, ctx.job.jobId, item.itemId, item.plannedDocId)
    }
    ctx.byPath.set(item.relativePath.toLowerCase(), item)
  }
  return items
}

/** Import the pending documents one by one. Returns true when the user cancelled. */
async function importDocuments(ctx: JobContext, items: ImportItemRow[]): Promise<boolean> {
  let sinceCount = 0
  for (const item of items) {
    if (item.kind !== 'doc' || item.status !== 'pending') continue
    if ((await importJobHeartbeat(by, ctx.job.jobId)).cancelRequested) return true
    try {
      await importOne(ctx, item)
    } catch (e) {
      if (!(e instanceof ItemFailure)) log.warn('import item failed', { jobId: ctx.job.jobId, err: e })
      await finishJobItem(by, ctx.job.jobId, item.itemId, { status: 'failed', reason: e instanceof ItemFailure ? e.reason : 'conversion-failed' })
    }
    item.status = 'done'
    if (++sinceCount >= 10) {
      sinceCount = 0
      await refreshJobCounters(by, ctx.job.jobId)
    }
  }
  return false
}

/** Close the remaining items: cancelled documents, used / unused images. */
async function settleItems(ctx: JobContext): Promise<void> {
  for (const item of await listJobItems(by, ctx.job.jobId)) {
    if (item.status !== 'pending') continue
    if (item.kind === 'doc') await finishJobItem(by, ctx.job.jobId, item.itemId, { status: 'skipped', reason: 'cancelled' })
    else if (item.kind === 'image') await finishJobItem(by, ctx.job.jobId, item.itemId, { status: ctx.usedImages.has(item.itemId) ? 'done' : 'skipped' })
  }
}

async function endJob(job: ImportJobRow, status: 'done' | 'failed' | 'cancelled', error: string | null): Promise<void> {
  await cleanupStaging(job.jobId)
  await refreshJobCounters(by, job.jobId)
  await finishImportJob(by, job.jobId, status, error)
  const row = await getImportJobForWorker(by, job.jobId)
  await appendAuditEvent({
    by: by.actingFor(job.userId),
    actorIp: null,
    scope: job.workspaceId ? 'workspace' : 'user',
    scopeId: job.workspaceId ?? String(job.userId),
    workspaceId: job.workspaceId,
    action: 'import.completed',
    metadata: { jobId: job.jobId, source: job.source, status, total: row?.total ?? 0, done: row?.done ?? 0, failed: row?.failed ?? 0, skipped: row?.skipped ?? 0 }
  })
}

/** Process one claimed job to its end. */
export async function processImportJob(job: ImportJobRow): Promise<void> {
  const proofs = await proveImportJobScope(by, job)
  if (!proofs) {
    await endJob(job, 'failed', 'access-lost')
    return
  }
  const caps = capsFor(await resolveUserPlan(job.userId))
  const ctx: JobContext = { job, proofs, archives: new Map(), byPath: new Map(), folders: new Map(), usedImages: new Set(), importMaxBytes: caps.importMaxBytes }

  const failure = await expandArchives(ctx, await listJobItems(by, job.jobId), { files: caps.importFilesPerJob, bytes: caps.importBytesPerJob })
  if (failure) {
    await endJob(job, 'failed', failure)
    return
  }
  const items = await planDocuments(ctx)
  await refreshJobCounters(by, job.jobId)
  const cancelled = await importDocuments(ctx, items)
  await settleItems(ctx)
  await endJob(job, cancelled ? 'cancelled' : 'done', null)
}

async function cleanupStaging(jobId: string): Promise<void> {
  try {
    const store = s3ObjectStore(useS3Client(), useEnv().storage.bucket)
    const objects = await store.list(`imports/${jobId}/`)
    await store.deleteMany(objects.map(o => o.key))
  } catch (e) {
    log.warn('staging clean-up failed', { jobId, err: e })
  }
}

/** One worker run: claim the oldest queued job and process it. */
export async function runImportWorker(): Promise<{ jobId: string } | null> {
  const job = await claimQueuedImportJob(by)
  if (!job) return null
  try {
    await processImportJob(job)
  } catch (e) {
    log.error('import job failed', { jobId: job.jobId, err: e })
    await finishImportJob(by, job.jobId, 'failed', 'internal')
    await refreshJobCounters(by, job.jobId).catch(() => {})
  }
  return { jobId: job.jobId }
}
