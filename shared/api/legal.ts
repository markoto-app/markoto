// Request schemas of the legal-surface, admin, audit-log and import routes
// (abuse reports, consent, waitlist, anonymous gate, `/api/admin/**`,
// `/api/workspaces/:wsId/audit/**`). Shared with the client, which may
// validate a form with the same schema before sending.
//
// Several routes here are public and abuse-sensitive. Their business rules
// answer with one distinct code per rule (`abuse/url-required`,
// `waitlist/invalid-email`, ...) that the forms translate, so those fields are
// typed loosely here (`z.unknown()`) and judged by the handler; the schema only
// guarantees the body is an object (or missing).
import { z } from 'zod'
import { clickIdBody } from '../analytics/attribution'
import { PG_INTEGER_MAX } from './ids'
import { ANON_GATE_PURPOSES } from '../config/anonGate'
import { STATS_BUCKETS, STATS_RANGES } from '../contracts/adminStats'

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** True for a real calendar day (`2026-13-99` has the shape but is not one). */
const isCalendarDay = (s: string): boolean => {
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/**
 * A `YYYY-MM-DD` calendar day; anything else (or a repeated key) falls back to
 * the route's default window instead of failing. Postgres rejects an impossible
 * date in the spend query's `::date` cast, so the shape alone is not enough.
 */
const isoDayOrDefault = z.string().regex(ISO_DAY).refine(isCalendarDay).optional().catch(undefined)

/** POST /api/abuse-reports. The anonymous bot-check solution travels as `altcha`; `docId` is an alias of `contentUrl`. */
export const submitAbuseReportBody = z.object({
  contentUrl: z.unknown().optional(),
  docId: z.unknown().optional(),
  category: z.unknown().optional(),
  body: z.unknown().optional(),
  reporterName: z.unknown().optional(),
  reporterEmail: z.unknown().optional(),
  goodFaith: z.unknown().optional(),
  locale: z.unknown().optional(),
  altcha: z.unknown().optional()
}).nullish()

const ABUSE_REPORT_STATUS_FILTERS = ['open', 'acknowledged', 'actioned', 'dismissed', 'all'] as const

/** GET /api/admin/abuse-reports. An unknown `status` shows the default queue; a non-numeric `limit` the default page (50), any other is clamped to 1–100. */
export const listAbuseReportsQuery = z.object({
  status: z.enum(ABUSE_REPORT_STATUS_FILTERS).optional().catch(undefined),
  limit: z.coerce.number().optional().catch(undefined)
    .transform(v => v === undefined ? 50 : Math.min(100, Math.max(1, Math.trunc(v))))
})

/** PATCH /api/admin/abuse-reports/:reportId. The decision's fields are judged by the handler (one code per rule). */
export const updateAbuseReportParams = z.object({ reportId: z.string().min(1) })
export const updateAbuseReportBody = z.object({
  status: z.enum(['acknowledged', 'actioned', 'dismissed']),
  notes: z.unknown().optional(),
  decision: z.object({
    action: z.unknown().optional(),
    rule: z.unknown().optional(),
    explanation: z.unknown().optional()
  // Not an object: no decision. Ignored for `acknowledged`; the other statuses
  // then answer the missing-explanation code like an empty decision.
  }).nullish().catch(null)
})

/** GET /api/admin/ai-spend. Invalid dates fall back to the last 30 days so a typo'd URL still shows a chart. */
export const aiSpendQuery = z.object({ from: isoDayOrDefault, to: isoDayOrDefault })

/** GET /api/admin/stats/*. An unknown range shows the last 30 days; an unknown bucket the range's default. */
export const adminStatsQuery = z.object({
  range: z.enum(STATS_RANGES).optional().catch(undefined).transform(r => r ?? '30'),
  bucket: z.enum(STATS_BUCKETS).optional().catch(undefined)
})

/** GET /api/admin/axis-spend. */
export const axisSpendQuery = z.object({
  axis: z.enum(['workspace', 'user', 'doc']),
  value: z.string().min(1).max(64),
  from: isoDayOrDefault,
  to: isoDayOrDefault
})

/** DELETE /api/admin/documents/:docId/moderation-restriction. The note's length is judged by the handler (`moderation/note-required`). */
export const liftModerationRestrictionParams = z.object({ docId: z.string().min(1) })
export const liftModerationRestrictionBody = z.object({ note: z.unknown().optional() }).nullish()

/** GET /api/anon-gate/challenge. */
export const anonChallengeQuery = z.object({ purpose: z.enum(ANON_GATE_PURPOSES).default('doc-create') })

/** POST /api/consent. The decisions are normalised (one per purpose, essential only, at most ten) by the handler. */
export const recordConsentBody = z.object({
  decisions: z.unknown().optional(),
  locale: z.unknown().optional()
}).nullish()

/** POST /api/waitlist. */
export const joinWaitlistBody = z.object({
  email: z.unknown().optional(),
  locale: z.unknown().optional(),
  consent: z.unknown().optional(),
  // Google Ads click id of this visit (shared/analytics/attribution.ts).
  attribution: clickIdBody.optional()
}).nullish()

/** POST /api/waitlist/confirm and /unsubscribe: the raw single-use token from the email link. */
export const waitlistTokenBody = z.object({ token: z.unknown().optional() }).nullish()

// Workspace audit log -------------------------------------------------------

const auditAction = z.union([
  z.literal('').transform((): undefined => undefined),
  z.string().regex(/^[a-z_.]{1,64}$/)
]).optional()

/** A date the filter accepts: anything `new Date()` parses; empty means "no bound". */
const auditDate = z.union([
  z.literal('').transform((): undefined => undefined),
  z.string().refine(s => !Number.isNaN(new Date(s).getTime())).transform(s => new Date(s))
]).optional()

/** GET /api/workspaces/:wsId/audit. `before` is the id cursor of the previous page. */
export const listAuditEventsQuery = z.object({
  // Past the largest id every row is older: the first page.
  before: z.coerce.number().int().positive().transform(v => Math.min(v, PG_INTEGER_MAX)).optional(),
  action: auditAction,
  from: auditDate,
  to: auditDate
})

/** GET /api/workspaces/:wsId/audit/export. The export always starts at the newest event, so it takes no cursor. */
export const exportAuditEventsQuery = z.object({
  format: z.enum(['csv', 'jsonl']).optional(),
  action: auditAction,
  from: auditDate,
  to: auditDate
})
