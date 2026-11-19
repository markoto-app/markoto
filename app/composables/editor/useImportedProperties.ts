import type { DeepReadonly } from 'vue'
import type { ImportedDocProperties } from '~~/shared/utils/markdown/markdownFrontmatter'
import type { DocTheme } from '~~/shared/types/theme'
import type { CslItem } from '~~/shared/utils/citations/cslItem'
import type { CitationStyleId } from '~~/shared/utils/citations/citationStyles'

/**
 * Theme, properties and bibliography from an imported markoto Markdown
 * file. The server has validated every field
 * (server/utils/documents/markdownImport.ts); the setters check again
 * (setTheme: schema; ymeta: the sync server; the bibliography: when read).
 */
export function useImportedProperties(doc: {
  isReadOnly: Readonly<Ref<boolean>>
  title: Ref<string>
  description: Ref<string>
  audience: Ref<string>
  language: Ref<string>
  setTemplateId: (id: string) => void
  canEditTheme: Readonly<Ref<boolean>> | DeepReadonly<Ref<boolean>>
  setTheme: (theme: DocTheme) => void
  bibliography: { addItems: (items: readonly CslItem[]) => unknown, setStyle: (style: CitationStyleId) => void }
}) {
  const { t } = useI18n()
  const toast = useToast()
  return function applyImportedProperties(
    properties: ImportedDocProperties,
    notes: { ignored: string[], droppedCustomCssRules: number }
  ) {
    if (doc.isReadOnly.value) return
    if (properties.title !== undefined) doc.title.value = properties.title
    if (properties.description !== undefined) doc.description.value = properties.description
    if (properties.audience !== undefined) doc.audience.value = properties.audience
    if (properties.language !== undefined) doc.language.value = properties.language
    if (properties.templateId !== undefined) doc.setTemplateId(properties.templateId)
    if (properties.theme && doc.canEditTheme.value) doc.setTheme(properties.theme)
    if (properties.references) doc.bibliography.addItems(properties.references)
    if (properties.citationStyle) doc.bibliography.setStyle(properties.citationStyle)
    const skipped = notes.ignored.length > 0 || notes.droppedCustomCssRules > 0
    toast.add({
      title: t('import.propertiesApplied'),
      description: skipped ? t('import.propertiesPartlyApplied') : undefined,
      icon: 'i-lucide-file-check-2',
      color: skipped ? 'neutral' : 'success'
    })
  }
}
