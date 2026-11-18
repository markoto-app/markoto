import { maskText } from './mask'
import type { JobMode } from './units'
import type { GlossaryEntry } from './workerPrompt'

// Deterministic glossary check after a job (translate / terminology):
// a unit is flagged when a glossary source term survived in its output, when
// the source had the term but the output lacks the target term, or when the
// target appears only in a variant spelling ("email" for "e-mail"). Code,
// links and other masked ranges are ignored. Flagged units can be rerun.
// Pure (explicit imports only).

export interface GlossaryCheckUnit {
  ordinal: number
  /** Original unit text. */
  source: string
  /** Applied output text. */
  output: string
}

export type GlossaryViolationKind = 'source_term_left' | 'target_missing' | 'target_variant'

export interface GlossaryViolation {
  kind: GlossaryViolationKind
  source: string
  target: string
}

export interface FlaggedUnit {
  ordinal: number
  violations: GlossaryViolation[]
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether `term` occurs in `text` starting at a word boundary (inflected forms count: "Kunde" in "Kunden"). */
function hasTerm(text: string, term: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-regexp -- a glossary term, escaped literally
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}`, 'iu').test(text)
}

function squash(s: string): string {
  return s.toLowerCase().replace(/[\s\-_]+/g, '')
}

function prose(text: string): string {
  return maskText(text).masked
}

function unitViolations(unit: GlossaryCheckUnit, glossary: readonly GlossaryEntry[], mode: JobMode): GlossaryViolation[] {
  const src = prose(unit.source)
  const out = prose(unit.output)
  const found: GlossaryViolation[] = []
  for (const g of glossary) {
    const source = g.source.trim()
    const target = g.target.trim()
    if (!source || !target) continue
    const same = source.toLowerCase() === target.toLowerCase()
    if (!hasTerm(src, source)) continue
    // A target that starts with the source ("Kunde" -> "Kundenkonto") keeps the source inside it.
    const sourceInsideTarget = hasTerm(target, source)
    if (!same && !sourceInsideTarget && hasTerm(out, source)) {
      found.push({ kind: 'source_term_left', source, target })
      continue
    }
    if (hasTerm(out, target)) continue
    if (squash(out).includes(squash(target))) found.push({ kind: 'target_variant', source, target })
    else if (mode === 'terminology' || mode === 'translate') found.push({ kind: 'target_missing', source, target })
  }
  return found
}

/** The units whose output breaks the glossary. */
export function checkGlossary(units: readonly GlossaryCheckUnit[], glossary: readonly GlossaryEntry[], mode: JobMode): FlaggedUnit[] {
  if (glossary.length === 0) return []
  const flagged: FlaggedUnit[] = []
  for (const u of units) {
    const violations = unitViolations(u, glossary, mode)
    if (violations.length > 0) flagged.push({ ordinal: u.ordinal, violations })
  }
  return flagged
}
