import type { PendingAdConversion } from '../../repos/adConversions'

// Google Ads offline click-conversion upload
// (`customers/{id}:uploadClickConversions`, Google Ads API). This file
// builds the request rows; the sweep (`adConversionSweep.ts`) runs it as a
// dry run until the upload is wired to Google Ads API credentials (a
// developer token, an OAuth client and the customer id): the open item in
// docs/SELF-HOSTING.md#analytics-optional. Only the click id, the conversion action
// and the conversion time leave markoto: no email, no IP, no user agent.

/** Conversion action per kind: `customers/<customer id>/conversionActions/<id>`, created as type UPLOAD_CLICKS. */
export type ConversionActions = Partial<Record<PendingAdConversion['conversion'], string>>

export interface ClickConversionRow {
  gclid?: string
  gbraid?: string
  wbraid?: string
  conversionAction: string
  conversionDateTime: string
  // markoto asks no visitor for consent to ad-data sharing, so it states
  // that (docs/SELF-HOSTING.md#analytics-optional, open decision on consent).
  consent: { adUserData: 'GRANTED' | 'DENIED' }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `yyyy-mm-dd HH:mm:ss+00:00` (Google's format; UTC). */
export function googleAdsDateTime(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`
}

/** Rows for the conversions that have a configured conversion action; the rest are left out. */
export function buildClickConversions(pending: readonly PendingAdConversion[], actions: ConversionActions): ClickConversionRow[] {
  return pending.flatMap((p) => {
    const conversionAction = actions[p.conversion]
    if (!conversionAction) return []
    return [{
      [p.clickIdType]: p.clickId,
      conversionAction,
      conversionDateTime: googleAdsDateTime(p.convertedAt),
      consent: { adUserData: 'DENIED' as const }
    }]
  })
}
