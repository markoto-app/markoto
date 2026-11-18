import type { z } from 'zod'
import { z as zod } from 'zod'
import type { DocToolContext } from '../../agentic/toolContext'
import { applyMinimalDiff } from './sections/ytextDiff'

// Pieces the section-addressed edit tools share (structuralEditTools.ts,
// replaceAllTools.ts): the section reference argument, the session origin
// of their Y.js transactions and the one-transaction edit batch.

export const SectionRef = zod.string().trim().min(1).max(300)
export const SECTION_REF_HELP = 'An id from outline ("s-12"), a section number ("4.2") or the exact heading text.'

export type Args<T extends z.ZodType> = z.output<T>

export function originOf(ctx: DocToolContext): string {
  return `ai:assistant:${ctx.sessionId}`
}

export interface Edit { start: number, end: number, text: string }

/**
 * Apply non-overlapping edits in ONE transaction with the session origin,
 * back to front so earlier offsets stay valid; at one offset an insertion
 * goes first. Each edit is a minimal word diff, so comment anchors and
 * cursors on unchanged words stay.
 */
export function applyEdits(ctx: DocToolContext, edits: readonly Edit[]): void {
  const sorted = [...edits].sort((a, b) => b.start - a.start || (a.end - a.start) - (b.end - b.start))
  ctx.ydoc.transact(() => {
    for (const e of sorted) applyMinimalDiff(ctx.ytext, e.start, e.end, e.text)
  }, originOf(ctx))
}
