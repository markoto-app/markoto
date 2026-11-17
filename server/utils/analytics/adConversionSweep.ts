import {
  deleteAdConversionsBefore,
  pendingAdConversions,
  recordConfirmedWaitlistConversions
} from '../../repos/adConversions'
import { system } from '../../repos/proofs'
import { useLogger } from '../platform/logger'
import { buildClickConversions } from './googleAdsUpload'
import { useEnv } from '~~/shared/env/load'
import { DAY_MS } from '~~/shared/config/units'

const log = useLogger('ad-conversion-sweep')

// Hourly: deletes click-id conversions past their retention, adds the
// `waitlist_confirmed` conversions of confirmed waitlist sign-ups, and
// prepares the Google Ads upload. The upload itself is a dry run until
// Google Ads API credentials are wired (docs/operations-analytics.md):
// it counts what it would send and leaves the rows pending.
// Runs even with conversions switched off, so turning the flag off never
// leaves rows behind past their retention.

export interface AdConversionSweepResult {
  deleted: number
  confirmedAdded: number
  uploadable: number
}

const UPLOAD_BATCH = 2000

export async function runAdConversionSweep(now: Date = new Date()): Promise<AdConversionSweepResult> {
  const actor = system('ad-conversions')
  const { adsConversions, adsConversionRetentionDays } = useEnv().analytics
  const deleted = await deleteAdConversionsBefore(actor, new Date(now.getTime() - adsConversionRetentionDays * DAY_MS))
  const confirmedAdded = adsConversions ? await recordConfirmedWaitlistConversions(actor) : 0
  // Dry run: no conversion action is configured yet, so this only counts.
  const pending = adsConversions ? await pendingAdConversions(actor, UPLOAD_BATCH) : []
  const uploadable = buildClickConversions(pending, {}).length
  if (deleted > 0 || confirmedAdded > 0 || pending.length > 0) {
    log.info('ad conversions', { deleted, confirmedAdded, pending: pending.length, uploadable, upload: 'dry-run' })
  }
  return { deleted, confirmedAdded, uploadable }
}
