import type { ImportedDocProperties } from '~~/shared/utils/markdown/markdownFrontmatter'
import type { DocTheme } from '~~/shared/types/theme'

/**
 * Theme + properties from an imported markoto Markdown file. The server has
 * validated every field (server/utils/documents/markdownImport.ts); the
 * setters check again (setTheme: schema; ymeta: the sync server).
 */
export function useImportedProperties(doc: {
  isReadOnly: Readonly<Ref<boolean>>
  title: Ref<string>
  description: Ref<string>
  audience: Ref<string>
  language: Ref<string>
  setTemplateId: (id: string) => void
  canEditTheme: Readonly<Ref<boolean>>
  setTheme: (theme: DocTheme) => void
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
    const skipped = notes.ignored.length > 0 || notes.droppedCustomCssRules > 0
    toast.add({
      title: t('import.propertiesApplied'),
      description: skipped ? t('import.propertiesPartlyApplied') : undefined,
      icon: 'i-lucide-file-check-2',
      color: skipped ? 'neutral' : 'success'
    })
  }
}
