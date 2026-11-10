import { and, asc, eq, isNotNull, or, sql } from 'drizzle-orm'
import { customDomains, publishedPages } from '../db/schema'
import { useDatabase } from '../utils/database'

// Custom domains of published pages (WP13).

export type CustomDomainRow = typeof customDomains.$inferSelect

export interface CustomDomainWithPage extends CustomDomainRow {
  pageSlug: string | null
  pageDocId: string | null
  pageTitle: string | null
}

const withPage = {
  id: customDomains.id,
  hostname: customDomains.hostname,
  userId: customDomains.userId,
  pageId: customDomains.pageId,
  verifyToken: customDomains.verifyToken,
  status: customDomains.status,
  lastError: customDomains.lastError,
  verifiedAt: customDomains.verifiedAt,
  lastCheckedAt: customDomains.lastCheckedAt,
  createdAt: customDomains.createdAt,
  pageSlug: publishedPages.slug,
  pageDocId: publishedPages.docId,
  pageTitle: publishedPages.title
}

export async function listCustomDomainsForUser(userId: number): Promise<CustomDomainWithPage[]> {
  return useDatabase().select(withPage).from(customDomains)
    .leftJoin(publishedPages, eq(publishedPages.id, customDomains.pageId))
    .where(eq(customDomains.userId, userId))
    .orderBy(asc(customDomains.createdAt))
}

/** Tuple key (id, owner): another user's domain id answers null. */
export async function getCustomDomainForUser(id: string, userId: number): Promise<CustomDomainRow | null> {
  return (await useDatabase().select().from(customDomains)
    .where(and(eq(customDomains.id, id), eq(customDomains.userId, userId))).limit(1))[0] ?? null
}

export async function countCustomDomainsForUser(userId: number): Promise<number> {
  const rows = await useDatabase().select({ n: sql<number>`count(*)::int` }).from(customDomains).where(eq(customDomains.userId, userId))
  return rows[0]?.n ?? 0
}

/**
 * May `userId` add `hostname`? No when they already have it, or when
 * another account's claim is verified. Unproven claims of others never
 * block — whoever passes the DNS check first gets the domain.
 */
export async function isHostnameUnavailable(hostname: string, userId: number): Promise<boolean> {
  const rows = await useDatabase().select({ id: customDomains.id }).from(customDomains)
    .where(and(eq(customDomains.hostname, hostname), or(eq(customDomains.userId, userId), eq(customDomains.status, 'verified')))).limit(1)
  return rows.length > 0
}

/**
 * Hostnames that passed verification at some point, live or not (host
 * middleware: such a host that isn't live answers 404). Never-verified
 * claims don't count — anyone can add one, and it must not take an
 * instance's own other hostnames down.
 */
export async function listOnceVerifiedHostnames(): Promise<Set<string>> {
  const rows = await useDatabase().selectDistinct({ hostname: customDomains.hostname }).from(customDomains)
    .where(isNotNull(customDomains.verifiedAt))
  return new Set(rows.map(r => r.hostname))
}

/** Throws a unique violation (23505) when the hostname is taken. */
export async function insertCustomDomain(row: { id: string, hostname: string, userId: number, verifyToken: string }): Promise<void> {
  await useDatabase().insert(customDomains).values(row)
}

export async function deleteCustomDomain(id: string, userId: number): Promise<CustomDomainRow | null> {
  return (await useDatabase().delete(customDomains)
    .where(and(eq(customDomains.id, id), eq(customDomains.userId, userId))).returning())[0] ?? null
}

export async function setCustomDomainPage(id: string, userId: number, pageId: string | null): Promise<void> {
  await useDatabase().update(customDomains).set({ pageId })
    .where(and(eq(customDomains.id, id), eq(customDomains.userId, userId)))
}

/** Record a DNS check: success re-stamps `verified_at`; failure keeps a verified domain until its grace ends. */
export async function recordCustomDomainCheck(id: string, result: { ok: true } | { ok: false, problem: string, dropVerified: boolean }): Promise<CustomDomainRow | null> {
  const set = result.ok
    ? { status: 'verified' as const, verifiedAt: sql`now()`, lastError: null, lastCheckedAt: sql`now()` }
    : {
        lastError: result.problem,
        lastCheckedAt: sql`now()`,
        ...(result.dropVerified ? { status: 'failed' as const } : {})
      }
  return (await useDatabase().update(customDomains).set(set).where(eq(customDomains.id, id)).returning())[0] ?? null
}

/** Verified domains (Traefik routers, host middleware). */
export async function listVerifiedCustomDomains(): Promise<CustomDomainRow[]> {
  return useDatabase().select().from(customDomains).where(eq(customDomains.status, 'verified'))
}

/** Domains due for an automatic re-check. */
export async function listCustomDomainsToRecheck(opts: { pendingNewerThan: Date, verifiedCheckedBefore: Date, limit: number }): Promise<CustomDomainRow[]> {
  return useDatabase().select().from(customDomains).where(sql`
    (${customDomains.status} IN ('pending', 'failed') AND ${customDomains.createdAt} > ${opts.pendingNewerThan}
      AND (${customDomains.lastCheckedAt} IS NULL OR ${customDomains.lastCheckedAt} < now() - interval '10 minutes'))
    OR (${customDomains.status} = 'verified' AND (${customDomains.lastCheckedAt} IS NULL OR ${customDomains.lastCheckedAt} < ${opts.verifiedCheckedBefore}))
  `).limit(opts.limit)
}
