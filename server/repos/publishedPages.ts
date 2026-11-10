import { and, eq, ne, sql } from 'drizzle-orm'
import { publishedPages } from '../db/schema'
import { useDatabase } from '../utils/database'

// Published pages (WP13): one static web snapshot per document.

export type PublishedPageRow = typeof publishedPages.$inferSelect

export interface PublishedPageSummary {
  id: string
  docId: string
  slug: string
  title: string
  indexable: boolean
  publishedAt: Date
  updatedAt: Date
}

const summary = {
  id: publishedPages.id,
  docId: publishedPages.docId,
  slug: publishedPages.slug,
  title: publishedPages.title,
  indexable: publishedPages.indexable,
  publishedAt: publishedPages.publishedAt,
  updatedAt: publishedPages.updatedAt
}

export async function getPublishedPageSummary(docId: string): Promise<PublishedPageSummary | null> {
  return (await useDatabase().select(summary).from(publishedPages).where(eq(publishedPages.docId, docId)).limit(1))[0] ?? null
}

export async function getPublishedPageBySlug(slug: string): Promise<PublishedPageRow | null> {
  return (await useDatabase().select().from(publishedPages).where(eq(publishedPages.slug, slug)).limit(1))[0] ?? null
}

export async function getPublishedPageById(id: string): Promise<PublishedPageRow | null> {
  return (await useDatabase().select().from(publishedPages).where(eq(publishedPages.id, id)).limit(1))[0] ?? null
}

/** Does the page exist? (asset requests — never loads the snapshot) */
export async function publishedPageExists(id: string): Promise<boolean> {
  const rows = await useDatabase().select({ id: publishedPages.id }).from(publishedPages).where(eq(publishedPages.id, id)).limit(1)
  return rows.length > 0
}

/** Is `slug` used by a page of another document? */
export async function isSlugTaken(slug: string, exceptDocId: string): Promise<boolean> {
  const rows = await useDatabase().select({ id: publishedPages.id }).from(publishedPages)
    .where(and(eq(publishedPages.slug, slug), ne(publishedPages.docId, exceptDocId))).limit(1)
  return rows.length > 0
}

export interface PublishedSnapshot {
  title: string
  language: string
  html: string
  css: string
  fontsImport: string
  hljsUrl: string | null
}

/** First publish of a document. Throws on a slug / doc clash (unique indexes). */
export async function insertPublishedPage(row: PublishedSnapshot & { id: string, docId: string, slug: string, indexable: boolean, publishedByUserId: number }): Promise<void> {
  await useDatabase().insert(publishedPages).values(row)
}

/** Re-publish: new snapshot (and optionally slug / indexing), same page id. False when the page was taken down meanwhile. */
export async function updatePublishedSnapshot(docId: string, snap: PublishedSnapshot & { slug?: string, indexable?: boolean, publishedByUserId: number }): Promise<boolean> {
  const rows = await useDatabase().update(publishedPages).set({ ...snap, updatedAt: sql`now()` })
    .where(eq(publishedPages.docId, docId)).returning({ id: publishedPages.id })
  return rows.length > 0
}

export async function updatePublishSettings(docId: string, patch: { slug?: string, indexable?: boolean }): Promise<PublishedPageSummary | null> {
  return (await useDatabase().update(publishedPages).set({ ...patch, updatedAt: sql`now()` })
    .where(eq(publishedPages.docId, docId)).returning(summary))[0] ?? null
}

export async function deletePublishedPage(docId: string): Promise<{ id: string } | null> {
  return (await useDatabase().delete(publishedPages).where(eq(publishedPages.docId, docId)).returning({ id: publishedPages.id }))[0] ?? null
}

/** Every page id (orphan sweep of `published/<id>/` prefixes). */
export async function listPublishedPageIds(): Promise<Set<string>> {
  const rows = await useDatabase().select({ id: publishedPages.id }).from(publishedPages)
  return new Set(rows.map(r => r.id))
}

/** Pages of documents owned by a user, and pages the user published (data export). */
export async function listPublishedPagesForOwner(userId: number): Promise<PublishedPageSummary[]> {
  return useDatabase().select(summary).from(publishedPages)
    .where(sql`${publishedPages.docId} IN (SELECT doc_id FROM documents WHERE owner_id = ${userId}) OR ${publishedPages.publishedByUserId} = ${userId}`)
}
