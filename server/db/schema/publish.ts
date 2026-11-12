// Published web pages and custom domains.

import { pgTable, integer, text, timestamp, index, uniqueIndex, boolean } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'
import { documents } from './documents'

// A published page is a static web snapshot of a document: the HTML the
// print page rendered (markdown → sanitised HTML, theme CSS, no cover, no
// pagination), served at `/p/<slug>` (and on a verified custom domain)
// with a no-script CSP. Re-publishing replaces the snapshot; the document
// itself is never exposed through it. Its images and brand fonts are
// copied to `published/<id>/` in S3 so the page doesn't depend on the
// document's uploads (image GC, deletion) or access mode.
export const publishedPages = pgTable('published_pages', {
  id: text('id').primaryKey(),
  docId: text('doc_id').notNull().unique().references(() => documents.docId, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  language: text('language').notNull().default('en'),
  html: text('html').notNull(),
  css: text('css').notNull(),
  fontsImport: text('fonts_import').notNull().default(''),
  hljsUrl: text('hljs_url'),
  /** Off by default: `noindex` unless the publisher opts in. */
  indexable: boolean('indexable').notNull().default(false),
  publishedByUserId: integer('published_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

// A custom domain (plan feature `customDomains`) shows one published page
// at its root. Owned by the user who added it; verified by a TXT record
// `_markoto-verify.<hostname>` = `markoto-verify=<token>` plus a CNAME to
// the instance's pages host. Only `verified` domains are routed (Traefik
// HTTP provider) and get a certificate.
export const customDomains = pgTable('custom_domains', {
  id: text('id').primaryKey(),
  // Unique only among VERIFIED domains: an unproven claim must not block
  // the real owner (squatting). One row per user and hostname.
  hostname: text('hostname').notNull(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  pageId: text('page_id').references(() => publishedPages.id, { onDelete: 'set null' }),
  verifyToken: text('verify_token').notNull(),
  status: text('status', { enum: ['pending', 'verified', 'failed'] }).notNull().default('pending'),
  lastError: text('last_error'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_custom_domains_user').on(table.userId),
  index('idx_custom_domains_page').on(table.pageId),
  uniqueIndex('uq_custom_domains_verified_host').on(table.hostname).where(sql`${table.status} = 'verified'`),
  uniqueIndex('uq_custom_domains_user_host').on(table.userId, table.hostname)
])
