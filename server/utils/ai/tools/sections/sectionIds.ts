import * as Y from 'yjs'
import { isSectionNumber, parseSectionsCached, sectionLabel, type DocumentStructure, type Section } from './parse'

// Stable section ids (`s-<n>`) for one Y.Doc. Line numbers change with every
// edit above them; an id is a Y.RelativePosition at the heading line start,
// so it follows the heading through edits by collaborators and by earlier
// tool calls. Ids are kept per Y.Doc (WeakMap): the in-app loop opens its
// own connection per session, MCP reuses a pooled one per client session,
// so in both cases the ids live as long as the model's view of the outline.
// `s-0` is always the preamble.

interface IdEntry {
  id: string
  rel: Y.RelativePosition
  /** Title when the id was last placed, for re-locating a heading whose first character was rewritten. */
  title: string
}

interface DocIds {
  next: number
  entries: Map<string, IdEntry>
}

const registries = new WeakMap<Y.Doc, DocIds>()

function registryFor(ydoc: Y.Doc): DocIds {
  let reg = registries.get(ydoc)
  if (!reg) {
    reg = { next: 1, entries: new Map() }
    registries.set(ydoc, reg)
  }
  return reg
}

const PREAMBLE_ID = 's-0'

/** The Y.js handles the id registry needs: the document and its text (both tool contexts have them). */
export interface SectionDocHandles {
  ydoc: Y.Doc
  ytext: Y.Text
}

export interface SectionView {
  structure: DocumentStructure
  /** Section id per `structure.sections` index. */
  ids: string[]
}

interface Resolved { entry: IdEntry, index: number | null }

function normalisedTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase()
}

function idNumber(id: string): number {
  return Number(id.slice(2))
}

/**
 * Pass 1: ids whose relative position is still a heading start keep that
 * heading. When two ids land on one heading (the first one's heading was
 * deleted), the one whose title matches wins, then the older one. Returns
 * the ids that found no heading this way.
 */
function placeExact(structure: DocumentStructure, resolved: readonly Resolved[], ids: Array<string | null>): { unplaced: Resolved[], exact: Set<string> } {
  const byStart = new Map<number, Section>()
  for (const s of structure.sections) if (s.level > 0) byStart.set(s.startOffset, s)
  const claims = new Map<Section, Resolved[]>()
  const unplaced: Resolved[] = []
  for (const r of resolved) {
    const sec = r.index === null ? undefined : byStart.get(r.index)
    if (sec) claims.set(sec, [...(claims.get(sec) ?? []), r])
    else unplaced.push(r)
  }
  const exact = new Set<string>()
  for (const [sec, list] of claims) {
    const title = normalisedTitle(sec.title)
    const matches = (r: Resolved): number => Number(normalisedTitle(r.entry.title) === title)
    const [winner, ...losers] = [...list].sort((a, b) => matches(b) - matches(a) || idNumber(a.entry.id) - idNumber(b.entry.id))
    if (!winner) continue
    ids[sec.index] = winner.entry.id
    exact.add(winner.entry.id)
    unplaced.push(...losers)
  }
  return { unplaced, exact }
}

/** Pass 2: an id whose heading start moved follows the nearest free heading with the same title; the rest are dropped. */
function placeByTitle(structure: DocumentStructure, unplaced: Resolved[], ids: Array<string | null>, reg: DocIds): void {
  unplaced.sort((a, b) => idNumber(a.entry.id) - idNumber(b.entry.id))
  for (const r of unplaced) {
    const title = normalisedTitle(r.entry.title)
    const near = r.index ?? 0
    let best: Section | null = null
    for (const s of structure.sections) {
      if (ids[s.index] !== null || s.level === 0 || normalisedTitle(s.title) !== title) continue
      if (!best || Math.abs(s.startOffset - near) < Math.abs(best.startOffset - near)) best = s
    }
    // An id whose heading is gone is dropped (resolving it says so).
    if (best) ids[best.index] = r.entry.id
    else reg.entries.delete(r.entry.id)
  }
}

/**
 * Parse the current text and give every section its id. An id whose
 * relative position still lands on a heading start keeps that heading;
 * one whose heading start moved (its first character rewritten) follows
 * a heading with the same title nearest to where it now points; every
 * heading left over gets a new id. The registry is updated to the
 * current heading starts.
 */
export function sectionView(handles: SectionDocHandles): SectionView {
  const { ydoc, ytext } = handles
  const structure = parseSectionsCached(ytext.toJSON())
  const reg = registryFor(ydoc)
  const ids: Array<string | null> = structure.sections.map(s => (s.level === 0 ? PREAMBLE_ID : null))
  const resolved: Resolved[] = [...reg.entries.values()].map(entry => ({ entry, index: Y.createAbsolutePositionFromRelativePosition(entry.rel, ydoc)?.index ?? null }))
  const { unplaced, exact } = placeExact(structure, resolved, ids)
  placeByTitle(structure, unplaced, ids, reg)

  // New ids for the rest; the registry follows the current heading starts.
  const out = structure.sections.map((s) => {
    if (s.level === 0) return PREAMBLE_ID
    const value = ids[s.index] ?? `s-${reg.next++}`
    const kept = exact.has(value) ? reg.entries.get(value) : undefined
    if (kept) kept.title = s.title
    else reg.entries.set(value, { id: value, rel: Y.createRelativePositionFromTypeIndex(ytext, s.startOffset), title: s.title })
    return value
  })
  return { structure, ids: out }
}

export type SectionResolution
  = | { ok: true, view: SectionView, section: Section, id: string }
    | { ok: false, error: string }

const ID_RE = /^s-\d{1,9}$/

function describeCandidate(view: SectionView, s: Section): string {
  return `${view.ids[s.index] ?? '?'} "${sectionLabel(s)}" (line ${s.startLine})`
}

function found(view: SectionView, section: Section): SectionResolution {
  return { ok: true, view, section, id: view.ids[section.index] ?? PREAMBLE_ID }
}

function resolveById(view: SectionView, wanted: string): SectionResolution {
  const at = view.ids.indexOf(wanted)
  const section = view.structure.sections[at]
  if (section) return found(view, section)
  if (wanted === PREAMBLE_ID) return { ok: false, error: 'Error: the document has no preamble (text before the first heading), so there is no section s-0.' }
  return { ok: false, error: `Error: section id ${wanted} is unknown (its heading was removed, or the id comes from an older outline). Call outline again for the current ids.` }
}

function resolveByNumber(view: SectionView, wanted: string): SectionResolution {
  const num = wanted.replace(/\.$/, '')
  const hits = view.structure.sections.filter(s => s.level > 0 && s.number === num)
  const [only] = hits
  if (only && hits.length === 1) return found(view, only)
  if (hits.length > 1) return { ok: false, error: `Error: section number ${num} is ambiguous: ${hits.map(s => describeCandidate(view, s)).join(', ')}. Pass one of the ids.` }
  return { ok: false, error: `Error: no section is numbered ${num}. Call outline to see the sections.` }
}

function resolveByHeading(view: SectionView, wanted: string): SectionResolution {
  const text = normalisedTitle(wanted.replace(/^#{1,6}\s+/, ''))
  const sections = view.structure.sections.filter(s => s.level > 0)
  const hits = sections.filter(s => normalisedTitle(s.title) === text || normalisedTitle(s.bareTitle) === text || normalisedTitle(sectionLabel(s)) === text)
  const [only] = hits
  if (only && hits.length === 1) return found(view, only)
  if (hits.length > 1) return { ok: false, error: `Error: ${hits.length} headings read "${wanted}": ${hits.map(s => describeCandidate(view, s)).join(', ')}. Pass one of the ids.` }
  const near = sections.filter(s => normalisedTitle(s.title).includes(text)).slice(0, 5)
  const hint = near.length > 0 ? ` Headings containing it: ${near.map(s => describeCandidate(view, s)).join(', ')}.` : ' Call outline to see the sections.'
  return { ok: false, error: `Error: no heading reads "${wanted}".${hint}` }
}

/**
 * Find the section `ref` names: an id from outline (`s-12`), a section
 * number (`4.2`), or the heading text (case-insensitive, with or without
 * its number and `#` marks). Errors name the candidates when the
 * reference is ambiguous or unknown.
 */
export function resolveSection(handles: SectionDocHandles, ref: string): SectionResolution {
  const view = sectionView(handles)
  const wanted = ref.trim()
  if (wanted === '') return { ok: false, error: 'Error: section is empty. Pass an id from outline (like "s-12"), a section number ("4.2") or the heading text.' }
  if (ID_RE.test(wanted)) return resolveById(view, wanted)
  if (isSectionNumber(wanted)) return resolveByNumber(view, wanted)
  return resolveByHeading(view, wanted)
}
