import { asc, eq, isNull, lt, sql } from 'drizzle-orm'
import { adClickConversions, waitlistSignups } from '../db/schema'
import { useDatabase } from '../db/client'
import type { SystemActor, UserScope } from './proofs'
import type { ClickId } from '~~/shared/analytics/attribution'

// `ad_click_conversions`: Google Ads click ids of visits that converted
// (docs/operations-analytics.md). Every write is idempotent per
// (click id, conversion): a click counts once per kind.

export type AdConversionKind = typeof adClickConversions.$inferSelect['conversion']

export interface AdConversionInput {
  clickId: ClickId
  conversion: AdConversionKind
  userId?: number | null
}

/** Record a conversion; false when this click already has one of this kind. */
export async function recordAdConversion(_by: SystemActor, input: AdConversionInput): Promise<boolean> {
  const rows = await useDatabase().insert(adClickConversions).values({
    clickIdType: input.clickId.type,
    clickId: input.clickId.value,
    conversion: input.conversion,
    userId: input.userId ?? null
  }).onConflictDoNothing().returning({ id: adClickConversions.id })
  return rows.length > 0
}

/** A waitlist sign-up conversion, tied to the sign-up row of `email` (normalised). */
export async function recordWaitlistAdConversion(_by: SystemActor, clickId: ClickId, email: string): Promise<boolean> {
  const signup = (await useDatabase().select({ id: waitlistSignups.id }).from(waitlistSignups).where(eq(waitlistSignups.email, email)).limit(1))[0]
  if (!signup) return false
  const rows = await useDatabase().insert(adClickConversions).values({
    clickIdType: clickId.type,
    clickId: clickId.value,
    conversion: 'waitlist_signup',
    waitlistSignupId: signup.id
  }).onConflictDoNothing().returning({ id: adClickConversions.id })
  return rows.length > 0
}

/**
 * The first document of an account that signed up from an ad: reuses the
 * click of its `signup` row (a no-op for every other account, and for every
 * later document).
 */
export async function recordFirstDocumentFromSignupClick(self: UserScope): Promise<boolean> {
  const result = await useDatabase().execute(sql`
    INSERT INTO ad_click_conversions (click_id_type, click_id, conversion, user_id)
    SELECT click_id_type, click_id, 'first_document', user_id
    FROM ad_click_conversions
    WHERE user_id = ${self.userId} AND conversion = 'signup'
    ON CONFLICT DO NOTHING
    RETURNING id`)
  return result.rows.length > 0
}

/** Confirmed waitlist sign-ups whose sign-up came from an ad get a `waitlist_confirmed` row. */
export async function recordConfirmedWaitlistConversions(_by: SystemActor): Promise<number> {
  const result = await useDatabase().execute(sql`
    INSERT INTO ad_click_conversions (click_id_type, click_id, conversion, waitlist_signup_id, converted_at)
    SELECT c.click_id_type, c.click_id, 'waitlist_confirmed', c.waitlist_signup_id, w.confirmed_at
    FROM ad_click_conversions c
    JOIN waitlist_signups w ON w.id = c.waitlist_signup_id
    WHERE c.conversion = 'waitlist_signup' AND w.confirmed_at IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING id`)
  return result.rows.length
}

/** Rows older than `cutoff` are deleted (retention). */
export async function deleteAdConversionsBefore(_by: SystemActor, cutoff: Date): Promise<number> {
  const rows = await useDatabase().delete(adClickConversions)
    .where(lt(adClickConversions.convertedAt, cutoff))
    .returning({ id: adClickConversions.id })
  return rows.length
}

export interface PendingAdConversion {
  id: number
  clickIdType: ClickId['type']
  clickId: string
  conversion: AdConversionKind
  convertedAt: Date
}

/** Not yet uploaded, oldest first. */
export async function pendingAdConversions(_by: SystemActor, limit: number): Promise<PendingAdConversion[]> {
  return await useDatabase().select({
    id: adClickConversions.id,
    clickIdType: adClickConversions.clickIdType,
    clickId: adClickConversions.clickId,
    conversion: adClickConversions.conversion,
    convertedAt: adClickConversions.convertedAt
  }).from(adClickConversions)
    .where(isNull(adClickConversions.uploadedAt))
    .orderBy(asc(adClickConversions.convertedAt))
    .limit(limit)
}

// `type` (not `interface`) so rows fit the NDJSON writer of the data export.
export type AdConversionExport = {
  clickIdType: string
  clickId: string
  conversion: string
  convertedAt: string
  uploadedAt: string | null
}

/** The account's conversions, for the GDPR data export. */
export async function adConversionsForExport(self: UserScope): Promise<AdConversionExport[]> {
  const rows = await useDatabase().select({
    clickIdType: adClickConversions.clickIdType,
    clickId: adClickConversions.clickId,
    conversion: adClickConversions.conversion,
    convertedAt: adClickConversions.convertedAt,
    uploadedAt: adClickConversions.uploadedAt
  }).from(adClickConversions)
    .where(eq(adClickConversions.userId, self.userId))
    .orderBy(asc(adClickConversions.convertedAt))
  return rows.map(r => ({
    clickIdType: r.clickIdType,
    clickId: r.clickId,
    conversion: r.conversion,
    convertedAt: r.convertedAt.toISOString(),
    uploadedAt: r.uploadedAt?.toISOString() ?? null
  }))
}
