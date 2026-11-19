import type { CitationAssistSource } from '~/utils/editor/citationAssist'
import type { CslItem } from '~~/shared/utils/citations/cslItem'
import type { CitationStyleId } from '~~/shared/utils/citations/citationStyles'
import { documentLocale, captionLabelsFor } from '~~/shared/utils/documents/documentLocale'
import { crossrefWord } from '~~/shared/utils/citations/crossrefTerms'

/**
 * What the editor's `@` completion and hover read (citationAssist.ts): the
 * live bibliography, citation style and document language, as getters, so
 * the CodeMirror extension never needs reconfiguring.
 */
export function useCitationSource(
  bibliography: { items: Ref<readonly CslItem[]>, style: Ref<CitationStyleId> },
  language: Ref<string>
): CitationAssistSource {
  const { t } = useI18n()
  return {
    items: () => bibliography.items.value,
    style: () => bibliography.style.value,
    locale: () => documentLocale(language.value),
    labelWord: (kind) => {
      const locale = documentLocale(language.value)
      const captions = captionLabelsFor(locale)
      if (kind === 'fig') return captions.figure
      if (kind === 'tbl') return captions.table
      return crossrefWord(kind, locale)
    },
    unknownText: key => t('references.unknownKey', { key })
  }
}
