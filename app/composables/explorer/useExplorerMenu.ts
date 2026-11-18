import type { ContextMenuItem } from '@nuxt/ui'
import { menuActions, type ExplorerItem, type ExplorerPermissions, type MenuAction } from '~/utils/explorer/model'
import { DOC_LIST_SORTS, type DocListSort } from '~~/shared/api/explorer'

// The explorer's menus: the context menu of a row, a selection, a tree
// node or the empty space, and the toolbar's "Actions" menu, built from the
// pure permission matrix (`menuActions`) with labels, icons and shortcut hints.

const ACTION_META: Record<MenuAction, { icon: string, kbds?: string[], color?: 'error' }> = {
  open: { icon: 'i-lucide-external-link', kbds: ['enter'] },
  openNewTab: { icon: 'i-lucide-square-arrow-out-up-right' },
  rename: { icon: 'i-lucide-pencil', kbds: ['f2'] },
  moveTo: { icon: 'i-lucide-folder-input' },
  cut: { icon: 'i-lucide-scissors', kbds: ['meta', 'x'] },
  duplicate: { icon: 'i-lucide-copy' },
  copyLink: { icon: 'i-lucide-link' },
  copyLinks: { icon: 'i-lucide-link' },
  share: { icon: 'i-lucide-share-2' },
  delete: { icon: 'i-lucide-trash-2', kbds: ['delete'], color: 'error' },
  newDocument: { icon: 'i-lucide-file-plus' },
  newFolder: { icon: 'i-lucide-folder-plus', kbds: ['alt', 'n'] },
  import: { icon: 'i-lucide-upload' },
  paste: { icon: 'i-lucide-clipboard-paste', kbds: ['meta', 'v'] }
}

export function useExplorerMenu(opts: {
  perms: Readonly<Ref<ExplorerPermissions>>
  canPaste: Readonly<Ref<boolean>>
  isMobile: Readonly<Ref<boolean>>
  sort: Readonly<Ref<DocListSort>>
  dir: Readonly<Ref<'asc' | 'desc'>>
  setSort: (sort: DocListSort | undefined, dir: 'asc' | 'desc' | undefined) => void
  run: (action: MenuAction, targets: readonly ExplorerItem[]) => void
}) {
  const { t } = useI18n()

  function menuItems(targets: readonly ExplorerItem[]): ContextMenuItem[][] {
    return menuActions(opts.perms.value, targets, { canPaste: opts.canPaste.value }).map(group => group.map(action => ({
      label: action === 'delete' && targets.length > 1
        ? t('explorer.action.deleteN', { n: targets.length }, targets.length)
        : t(`explorer.action.${action}`),
      icon: ACTION_META[action].icon,
      kbds: opts.isMobile.value ? undefined : ACTION_META[action].kbds,
      color: ACTION_META[action].color,
      onSelect: () => opts.run(action, targets)
    })))
  }

  // Sort lives in the empty-space menu too (and in the toolbar).
  const viewMenu = computed<ContextMenuItem[]>(() => [{
    label: t('explorer.sortBy'),
    icon: 'i-lucide-arrow-down-up',
    children: [
      DOC_LIST_SORTS.map(s => ({
        label: t(`explorer.sort.${s}`),
        type: 'checkbox' as const,
        checked: opts.sort.value === s,
        onUpdateChecked: () => opts.setSort(s, undefined)
      })),
      (['asc', 'desc'] as const).map(d => ({
        label: t(`explorer.sortDirection.${d}`),
        type: 'checkbox' as const,
        checked: opts.dir.value === d,
        onUpdateChecked: () => opts.setSort(undefined, d)
      }))
    ]
  }])

  /** The context menu for `targets` (empty = the pane's empty space, which also offers sorting). */
  function contextMenu(targets: readonly ExplorerItem[]): ContextMenuItem[][] {
    return [...menuItems(targets), ...(targets.length === 0 ? [viewMenu.value] : [])]
  }

  return { menuItems, contextMenu }
}
