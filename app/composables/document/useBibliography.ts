import type * as Y from 'yjs'
import { BIBLIOGRAPHY_MAX_ENTRIES, readStoredBibliography, serializeItem, type CslItem } from '~~/shared/utils/citations/cslItem'
import { citationStyleOf, type CitationStyleId } from '~~/shared/utils/citations/citationStyles'
import { BIBLIOGRAPHY_ROOT, CITATION_STYLE_META_KEY } from '~~/shared/utils/citations/docBibliography'
import type { CitationInputs } from '~/utils/markdown/citationResolve'

/** Origin of bibliography writes made here (so undo of the text never takes them back). */
const BIBLIOGRAPHY_ORIGIN = 'bibliography'

export interface AddResult {
  added: number
  replaced: number
  /** Entries not added: the bibliography is full. */
  dropped: number
}

/**
 * The document's bibliography, shared by every editor of the document:
 * the `bibliography` Y.Map (citation key → CSL JSON string) and the
 * citation style in `ymeta.citationStyle`. Both are validated when read
 * (any editor can write them over Y.js); the render paths read the same
 * way (`server/utils/citations/docCitations.ts`).
 */
export function useBibliography(ydoc: Y.Doc, ymeta: Y.Map<unknown>, isReadOnly: Readonly<Ref<boolean>>) {
  const map = ydoc.getMap<unknown>(BIBLIOGRAPHY_ROOT)
  const items = shallowRef<CslItem[]>(readStoredBibliography(map.entries()))
  const style = ref<CitationStyleId>(citationStyleOf(ymeta.get(CITATION_STYLE_META_KEY)))

  const onBib = () => {
    items.value = readStoredBibliography(map.entries())
  }
  const onMeta = () => {
    style.value = citationStyleOf(ymeta.get(CITATION_STYLE_META_KEY))
  }
  map.observe(onBib)
  ymeta.observe(onMeta)
  onScopeDispose(() => {
    map.unobserve(onBib)
    ymeta.unobserve(onMeta)
  })

  const citations = computed<CitationInputs>(() => ({ items: items.value, style: style.value }))

  function setStyle(next: CitationStyleId) {
    if (isReadOnly.value) return
    ymeta.set(CITATION_STYLE_META_KEY, next)
  }

  /** Add entries; an existing key is replaced (the import is the newer source). */
  function addItems(next: readonly CslItem[]): AddResult {
    const result: AddResult = { added: 0, replaced: 0, dropped: 0 }
    if (isReadOnly.value || next.length === 0) return result
    ydoc.transact(() => {
      for (const item of next) {
        if (map.has(item.id)) result.replaced++
        else if (map.size >= BIBLIOGRAPHY_MAX_ENTRIES) {
          result.dropped++
          continue
        } else result.added++
        map.set(item.id, serializeItem(item))
      }
    }, BIBLIOGRAPHY_ORIGIN)
    return result
  }

  function removeItem(key: string) {
    if (isReadOnly.value) return
    ydoc.transact(() => map.delete(key), BIBLIOGRAPHY_ORIGIN)
  }

  function hasKey(key: string): boolean {
    return map.has(key)
  }

  return { items: computed(() => items.value), style: computed(() => style.value), citations, setStyle, addItems, removeItem, hasKey }
}
