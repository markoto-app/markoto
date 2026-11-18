import { h } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import type { ExplorerItem } from '~/utils/explorer/model'

// The explorer list's columns: (select boxes on a phone in select mode),
// name, then owner, last edited and size on wider screens. Cells other than
// the select box are rendered by the list's slots.

export function useExplorerColumns(opts: {
  selectMode: Readonly<Ref<boolean>>
  isMobile: Readonly<Ref<boolean>>
  isSelected: (key: string) => boolean
  toggle: (key: string) => void
}) {
  const { t } = useI18n()
  return computed<TableColumn<ExplorerItem>[]>(() => [
    ...(opts.selectMode.value
      ? [{
          id: 'select',
          header: '',
          cell: ({ row }: { row: { original: ExplorerItem } }) => h(resolveComponent('UCheckbox'), {
            'modelValue': opts.isSelected(row.original.key),
            'aria-label': t('explorer.selectItem', { name: row.original.label }),
            'onUpdate:modelValue': () => opts.toggle(row.original.key)
          }),
          meta: { class: { td: 'w-8' } }
        }]
      : []),
    { id: 'name', header: t('explorer.column.name') },
    ...(opts.isMobile.value
      ? []
      : [
          { id: 'owner', header: t('explorer.column.owner'), meta: { class: { td: 'w-40 text-muted', th: 'w-40' } } },
          { id: 'updated', header: t('explorer.column.updated'), meta: { class: { td: 'w-36 text-muted', th: 'w-36' } } },
          { id: 'words', header: t('explorer.column.words'), meta: { class: { td: 'w-28 text-muted text-right text-xs', th: 'w-28 text-right' } } }
        ])
  ])
}
