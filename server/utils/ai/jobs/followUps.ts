import type * as Y from 'yjs'
import { unitRev } from './units'
import { resolveUnitRange } from './runner'
import type { AiJobUnitRow } from '../../../repos/aiJobs'

// The AI session that ran a job often corrects the job's parts right after
// it (staging: a translation finished, then the planner fixed glossary drift
// in four chapters). Those corrections belong to the job: "Undo job" must
// put those parts back too, or the document ends up half translated.
//
// The session's own Y.Doc connection is watched: every local transaction
// with the session's origin (`ai:assistant:<sessionId>`) that changes a
// part still reading exactly as the job (or an earlier correction of this
// session) left it moves the part's `sessionAfterHash` to the new text.
// A part someone else changed first keeps its hashes, so undo keeps
// protecting that edit. No Nitro here: production wiring is `delegateTools.ts`.

type TrackedUnit = Pick<AiJobUnitRow, 'ordinal' | 'startRel' | 'endRel' | 'afterHash' | 'sessionAfterHash'>

export interface FollowUpStore {
  /** The job's applied / flagged parts that changed text. */
  listUnits(): Promise<TrackedUnit[]>
  saveSessionHash(ordinal: number, hash: string): Promise<void>
}

interface Tracker {
  origin: string
  jobs: Map<string, { units: TrackedUnit[], store: FollowUpStore }>
  before: WeakMap<Y.Transaction, Map<string, Map<number, string | null>>>
  pending: Set<Promise<void>>
}

const trackers = new WeakMap<Y.Doc, Tracker>()

/** The hashes a part may have and still count as the job's text. */
function jobHashes(u: TrackedUnit): Array<string | null> {
  return [u.afterHash, u.sessionAfterHash]
}

function hashesNow(doc: { ydoc: Y.Doc, ytext: Y.Text }, units: readonly TrackedUnit[]): Map<number, string | null> {
  const out = new Map<number, string | null>()
  const text = doc.ytext.toString()
  for (const u of units) {
    const range = resolveUnitRange(doc, u.startRel, u.endRel)
    out.set(u.ordinal, range ? unitRev(text.slice(range.start, range.end)) : null)
  }
  return out
}

function attach(ydoc: Y.Doc, ytext: Y.Text, origin: string): Tracker {
  const tracker: Tracker = { origin, jobs: new Map(), before: new WeakMap(), pending: new Set() }
  const doc = { ydoc, ytext }
  const ours = (tr: Y.Transaction) => tr.local && tr.origin === tracker.origin && tracker.jobs.size > 0
  ydoc.on('beforeTransaction', (tr: Y.Transaction) => {
    if (!ours(tr)) return
    const snapshot = new Map<string, Map<number, string | null>>()
    for (const [jobId, job] of tracker.jobs) snapshot.set(jobId, hashesNow(doc, job.units))
    tracker.before.set(tr, snapshot)
  })
  ydoc.on('afterTransaction', (tr: Y.Transaction) => {
    const snapshot = tracker.before.get(tr)
    if (!snapshot) return
    for (const [jobId, job] of tracker.jobs) {
      const was = snapshot.get(jobId)
      if (!was) continue
      const now = hashesNow(doc, job.units)
      for (const u of job.units) {
        const before = was.get(u.ordinal) ?? null
        const after = now.get(u.ordinal) ?? null
        if (before === null || after === null || before === after) continue
        if (!jobHashes(u).includes(before)) continue
        u.sessionAfterHash = after
        const p = job.store.saveSessionHash(u.ordinal, after).catch(() => undefined).finally(() => tracker.pending.delete(p))
        tracker.pending.add(p)
      }
    }
  })
  return tracker
}

/**
 * Count the session's later edits (transactions with `origin`, the
 * session's `ai:assistant:<sessionId>`) to the job's parts as part of the job.
 * Call it whenever the session learns the job's state (the parts and their
 * hashes are reloaded, so a rerun is picked up).
 */
export async function trackSessionFollowUps(doc: { ydoc: Y.Doc, ytext: Y.Text }, origin: string, jobId: string, store: FollowUpStore): Promise<void> {
  const units = (await store.listUnits()).filter(u => u.afterHash !== null)
  let tracker = trackers.get(doc.ydoc)
  if (!tracker) {
    tracker = attach(doc.ydoc, doc.ytext, origin)
    trackers.set(doc.ydoc, tracker)
  }
  tracker.jobs.set(jobId, { units, store })
}

/** Wait for the hash writes started so far (tests, session end). */
export async function flushSessionFollowUps(ydoc: Y.Doc): Promise<void> {
  const tracker = trackers.get(ydoc)
  if (tracker) await Promise.all([...tracker.pending])
}
