import type * as Y from 'yjs'
import { crossrefKind, findCitations } from '~~/shared/utils/citations/citeSyntax'
import { BIBLIOGRAPHY_ROOT } from '~~/shared/utils/citations/docBibliography'

/**
 * Grounded citing: text the AI writes into a document may only cite keys
 * that are in the document's bibliography. Checked by every AI edit tool
 * on the NEW text before it is applied (keys the replaced text already
 * cited are let through, so fixing a paragraph around a broken citation
 * still works). The model adds a work only through `add_reference_by_doi`,
 * which takes a DOI Crossref verifies, never an invented entry.
 *
 * Bracketed `[@key]` always counts; a bare `@key` only when it looks like a
 * citation key (has a digit, as `smith2020`), so `@team` stays prose.
 * Cross-references (`@fig:x`) are not citations.
 */
export function ungroundedCitations(newText: string, replacedText: string, ydoc: Y.Doc): string[] {
  if (!newText.includes('@')) return []
  const bib = ydoc.getMap<unknown>(BIBLIOGRAPHY_ROOT)
  const before = new Set(findCitations(replacedText).map(c => c.key))
  const missing = new Set<string>()
  for (const c of findCitations(newText)) {
    if (crossrefKind(c.key) || bib.has(c.key) || before.has(c.key)) continue
    if (!c.bracketed && !/\d/.test(c.key)) continue
    missing.add(c.key)
  }
  return [...missing]
}

/** The tool error for `ungroundedCitations` hits (null when there are none). */
export function ungroundedCitationError(newText: string, replacedText: string, ydoc: Y.Doc): string | null {
  const missing = ungroundedCitations(newText, replacedText, ydoc)
  if (missing.length === 0) return null
  const list = missing.slice(0, 10).map(k => `@${k}`).join(', ')
  return `Error: nothing was changed. These citation keys are not in the document's bibliography: ${list}. Cite only keys that list_references returns. To cite another work, add it first with add_reference_by_doi (a real DOI, verified at Crossref); never invent a reference or a key. If you cannot find a verified source, write the sentence without a citation and tell the user which claim needs one.`
}
