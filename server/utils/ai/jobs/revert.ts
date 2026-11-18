import { applyMinimalDiff } from '../tools/sections/ytextDiff'
import { unitRev } from './units'
import { relativeRange, resolveUnitRange } from './runner'
import type { AiJobStatus } from '../../../repos/aiJobs'
import type { JobDocHandles, JobStore } from './jobTypes'

// "Undo job": every applied unit whose current text is still exactly what
// the job wrote goes back to its stored before text, one transaction per
// unit (origin `ai:job:<id>:revert`). Units edited since, deleted, or past
// the 7-day undo window stay as they are and are reported. A whole-document
// restore would also revert other people's edits made during the job.
// No Nitro here: production wiring is `engine.ts`.

function revertOrigin(jobId: string): string {
  return `ai:job:${jobId}:revert`
}

export interface RevertSkip {
  ordinal: number
  headingPath: string
  reason: string
}

export interface RevertResult {
  reverted: number
  skipped: RevertSkip[]
}

export const REVERT_EDITED_SINCE = 'Edited after the job; left as it is.'
const REVERT_EXPIRED = 'The undo copy is gone (kept 7 days).'
const REVERT_DELETED = 'The section no longer exists.'

const REVERTIBLE_FROM: readonly AiJobStatus[] = ['done', 'cancelled', 'failed', 'stopped_access', 'paused_budget', 'interrupted']

export async function revertJobUnits(deps: { jobId: string, store: JobStore, doc: JobDocHandles }): Promise<RevertResult> {
  const { store, doc } = deps
  const units = await store.listUnits(['applied', 'flagged'])
  const skipped: RevertSkip[] = []
  let reverted = 0
  for (const u of units) {
    if (u.afterHash === null) continue // comment / scan units changed no text
    const skip = (reason: string) => skipped.push({ ordinal: u.ordinal, headingPath: u.headingPath, reason })
    if (u.beforeText === null) {
      skip(REVERT_EXPIRED)
      continue
    }
    const range = resolveUnitRange(doc, u.startRel, u.endRel)
    if (!range) {
      skip(REVERT_DELETED)
      continue
    }
    const current = doc.ytext.toString().slice(range.start, range.end)
    if (unitRev(current) !== u.afterHash) {
      skip(REVERT_EDITED_SINCE)
      continue
    }
    const before = u.beforeText
    doc.ydoc.transact(() => {
      applyMinimalDiff(doc.ytext, range.start, range.end, before)
    }, revertOrigin(deps.jobId))
    await store.updateUnit(u.ordinal, { status: 'reverted', ...relativeRange(doc.ytext, range.start, range.start + before.length) })
    reverted++
  }
  if (reverted > 0) await store.transition(REVERTIBLE_FROM, 'reverted', { currentHeading: null })
  return { reverted, skipped }
}
