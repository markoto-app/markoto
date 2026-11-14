import { docsNavSections, type DocsNavNode } from '~~/shared/docs/docsSections'

// The docs navigation tree, loaded once per page view and shared by the
// docs layout (sidebar, search groups) and the docs page (prev / next
// pager): both call this with the same key, so there is one query.
export async function useDocsNav(): Promise<ComputedRef<DocsNavNode[]>> {
  const { data } = await useAsyncData('docs:nav', () =>
    queryCollectionNavigation('docs', ['order', 'navHidden', 'icon', 'description'])
  )
  return computed(() => docsNavSections(data.value as DocsNavNode[] | null | undefined))
}
