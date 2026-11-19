import { applyMinimalDiff } from '../tools/sections/ytextDiff'
import { parseSuggestion } from '../../../../shared/utils/suggestions/record'
import { suggestionsMap } from '../../../../shared/utils/suggestions/ySuggestions'
import { unitRev } from './units'
import { relativeRange, resolveUnitRange } from './runner'
import type { AiJobStatus } from '../../../repos/aiJobs'
import type { JobDocHandles, JobStore } from './jobTypes'

// "Undo job": every applied unit whose current text is still exactly what
// the job wrote, or what the AI session that ran the job made of it
// afterwards (`sessionAfterHash`, `followUps.ts`), goes back to its stored
// before text, one transaction per unit (origin `ai:job:<id>:revert`).
// Units edited since by anybody else, deleted, or past the 7-day undo
// window stay as they are and are reported. A whole-document restore would
// also revert other people's edits made during the job.
// No Nitro here: production wiring is `engine.ts`.

function revertOrigin(jobId: string): string {
  return `ai:job:${jobId}:revert`
}

/** Why undo left a part as it is. */
export type RevertKeptKind = 'edited' | 'expired' | 'deleted'

export interface RevertSkip {
  ordinal: number
  headingPath: string
  kind: RevertKeptKind
  reason: string
}

export interface RevertResult {
  reverted: number
  /** Of `reverted`: parts the job's AI session had corrected after the job; undone with it. */
  followUps: number
  skipped: RevertSkip[]
}

export const REVERT_EDITED_SINCE = 'Edited after the job; left as it is.'
const REVERT_EXPIRED = 'The undo copy is gone (kept 7 days).'
const REVERT_DELETED = 'The section no longer exists.'
const REASONS: Record<RevertKeptKind, string> = { edited: REVERT_EDITED_SINCE, expired: REVERT_EXPIRED, deleted: REVERT_DELETED }

const REVERTIBLE_FROM: readonly AiJobStatus[] = ['done', 'cancelled', 'failed', 'stopped_access', 'paused_budget', 'interrupted']

type Unit = Awaited<ReturnType<JobStore['listUnits']>>[number]

/** Whether a unit can be undone, and what with. */
function revertCheck(doc: JobDocHandles, u: Unit): 'nothing' | { kept: RevertKeptKind } | { range: { start: number, end: number }, followUp: boolean, before: string } {
  if (u.beforeText === null) return { kept: 'expired' }
  const range = resolveUnitRange(doc, u.startRel, u.endRel)
  if (!range) return { kept: 'deleted' }
  const current = doc.ytext.toString().slice(range.start, range.end)
  // Already reads as before the job (a suggestion nobody accepted, removed
  // by `removeJobSuggestions`, or someone undid it by hand): nothing to do.
  if (current === u.beforeText) return 'nothing'
  const rev = unitRev(current)
  const followUp = u.sessionAfterHash !== null && rev === u.sessionAfterHash && rev !== u.afterHash
  if (rev !== u.afterHash && !followUp) return { kept: 'edited' }
  return { range, followUp, before: u.beforeText }
}

export async function revertJobUnits(deps: { jobId: string, store: JobStore, doc: JobDocHandles }): Promise<RevertResult> {
  const { store, doc } = deps
  const units = await store.listUnits(['applied', 'flagged'])
  const skipped: RevertSkip[] = []
  let reverted = 0
  let followUps = 0
  // A job in suggestion mode: its suggestions nobody decided yet go away
  // (one transaction); units a person accepted are undone below like
  // applied ones (their text is what the job wrote).
  const pending = removeJobSuggestions(doc, deps.jobId)
  if (pending.units > 0) reverted += pending.units
  for (const u of units) {
    if (u.afterHash === null) continue // comment / scan units changed no text
    const check = revertCheck(doc, u)
    if (check === 'nothing') continue
    if ('kept' in check) {
      skipped.push({ ordinal: u.ordinal, headingPath: u.headingPath, kind: check.kept, reason: REASONS[check.kept] })
      continue
    }
    const { range, followUp, before } = check
    doc.ydoc.transact(() => {
      applyMinimalDiff(doc.ytext, range.start, range.end, before)
    }, revertOrigin(deps.jobId))
    await store.updateUnit(u.ordinal, { status: 'reverted', ...relativeRange(doc.ytext, range.start, range.start + before.length) })
    reverted++
    if (followUp) followUps++
  }
  if (reverted > 0) await store.transition(REVERTIBLE_FROM, 'reverted', { currentHeading: null })
  return { reverted, followUps, skipped }
}

/**
 * Remove the job's open suggestions. `units` counts the units (suggestion
 * groups) they belonged to, so "N parts restored" reads the same in both modes.
 */
export function removeJobSuggestions(doc: JobDocHandles, jobId: string): { units: number, suggestions: number } {
  const map = suggestionsMap(doc.ydoc)
  const ids: string[] = []
  const groups = new Set<string>()
  for (const [key, value] of map.entries()) {
    const r = parseSuggestion(value)
    if (r?.jobId === jobId) {
      ids.push(key)
      groups.add(r.groupId ?? key)
    }
  }
  if (ids.length > 0) {
    doc.ydoc.transact(() => {
      for (const id of ids) map.delete(id)
    }, revertOrigin(jobId))
  }
  return { units: groups.size, suggestions: ids.length }
}
