import type * as Y from 'yjs'
import { readStoredBibliography, type CslItem } from '~~/shared/utils/citations/cslItem'
import { citationStyleOf, type CitationStyleId } from '~~/shared/utils/citations/citationStyles'
import { BIBLIOGRAPHY_ROOT, CITATION_STYLE_META_KEY } from '~~/shared/utils/citations/docBibliography'

/**
 * A document's bibliography (the `bibliography` Y.Map: citation key → CSL
 * JSON string) and citation style (`ymeta.citationStyle`), validated: any
 * editor can write both over Y.js, so every reader parses and bounds them.
 */
export function readDocCitations(ydoc: Y.Doc): { items: CslItem[], style: CitationStyleId } {
  const map = ydoc.getMap<unknown>(BIBLIOGRAPHY_ROOT)
  return {
    items: readStoredBibliography(map.entries()),
    style: citationStyleOf(ydoc.getMap('meta').get(CITATION_STYLE_META_KEY))
  }
}
