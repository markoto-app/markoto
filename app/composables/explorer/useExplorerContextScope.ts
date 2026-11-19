import type { ExplorerItem } from '~/utils/explorer/model'
import { useSetContextScope } from '~/queries/projectContext'
import type { ContextScope } from '~~/shared/config/projectContext'
import type { ExplorerScope } from './useExplorerData'

// The explorer's "Use as AI context" menu: mark a document as project
// context for its folder or its whole scope, or unmark it. The list then
// refetches so the row's badge follows.
export function useExplorerContextScope(opts: {
  scope: Readonly<Ref<ExplorerScope>>
  afterChange: () => Promise<void>
  announce: (text: string) => void
  handleError: (e: unknown, fallbackKey: string) => Promise<boolean>
}) {
  const { t } = useI18n()
  const mutation = useSetContextScope()

  async function setContextScope(item: ExplorerItem, scope: ContextScope | null): Promise<void> {
    if (item.kind !== 'doc') return
    try {
      await mutation.mutateAsync({ docId: item.id, scope })
      await opts.afterChange()
      opts.announce(t(scope ? 'explorer.announce.contextOn' : 'explorer.announce.contextOff', { name: item.label }))
    } catch (e) {
      await opts.handleError(e, 'explorer.error.context')
    }
  }

  /** The `all` choice is the workspace, or all personal documents. */
  const inWorkspace = computed(() => opts.scope.value.kind === 'workspace')

  return { setContextScope, inWorkspace }
}
