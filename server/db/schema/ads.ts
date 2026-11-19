// Google Ads click-id conversions (docs/SELF-HOSTING.md#analytics-optional).

import { pgTable, serial, integer, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'
import { waitlistSignups } from './billing'

// One row per (click id, conversion): a visit from a Google ad that led to
// a sign-up, a waitlist sign-up (and its confirmation) or a first
// document. Written only while NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS is on
// and the request carried no Global Privacy Control / Do Not Track signal.
// Read by the offline conversion upload; deleted
// NUXT_ADS_CONVERSION_RETENTION_DAYS (90) after `converted_at` by
// `server/utils/analytics/adConversionSweep.ts`.
//
// Privacy shape:
//   - the click id is Google's pseudonymous token for one ad click; no
//     email, name, IP or user agent is stored;
//   - `user_id` links a sign-up so later conversions of the same account
//     reuse the click and the data export can list it; CASCADE, so account
//     deletion removes the rows;
//   - `waitlist_signup_id` ties the confirmation to the sign-up; CASCADE,
//     so unsubscribing (which deletes the sign-up) removes them too.
export const adClickConversions = pgTable('ad_click_conversions', {
  id: serial('id').primaryKey(),
  clickIdType: text('click_id_type', { enum: ['gclid', 'gbraid', 'wbraid'] }).notNull(),
  clickId: text('click_id').notNull(),
  conversion: text('conversion', { enum: ['signup', 'waitlist_signup', 'waitlist_confirmed', 'first_document'] }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  waitlistSignupId: integer('waitlist_signup_id').references(() => waitlistSignups.id, { onDelete: 'cascade' }),
  convertedAt: timestamp('converted_at', { withTimezone: true }).notNull().defaultNow(),
  // Set once Google Ads accepted the row (upload job).
  uploadedAt: timestamp('uploaded_at', { withTimezone: true })
}, table => [
  // A click converts once per kind (a second document is not a conversion).
  uniqueIndex('uq_ad_click_conversions_click_kind').on(table.clickId, table.conversion),
  index('idx_ad_click_conversions_user').on(table.userId),
  index('idx_ad_click_conversions_waitlist').on(table.waitlistSignupId),
  index('idx_ad_click_conversions_converted_at').on(table.convertedAt),
  index('idx_ad_click_conversions_pending').on(table.convertedAt).where(sql`${table.uploadedAt} IS NULL`)
])
