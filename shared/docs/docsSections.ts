// The sections of the user docs, in sidebar order, with their titles. Each
// is a folder under content/docs with an index.md (the same title, plus
// description, icon, order). Breadcrumbs take the section title from here.
// The /docs landing page lists them in this order; tests/unit/seo/
// docsSections.test.ts checks the folders and their `order` agree.
export const DOCS_SECTION_TITLES = {
  'getting-started': 'Get started',
  'writing': 'Write',
  'ai': 'AI assistant',
  'collaborate': 'Collaborate',
  'sharing': 'Share and publish',
  'themes': 'Design',
  'import-export': 'Import, export and history',
  'workspaces': 'Workspaces',
  'workspace-admin': 'Workspace administration',
  'plans': 'Plans and billing',
  'account': 'Account and privacy',
  'self-hosting': 'Run markoto yourself'
} as const

export type DocsSection = keyof typeof DOCS_SECTION_TITLES

/** Section folders in sidebar order. */
export const DOCS_SECTIONS = Object.keys(DOCS_SECTION_TITLES) as DocsSection[]

/** Title of a section folder (`ai` → `AI assistant`), or null for any other slug. */
export function docsSectionTitle(slug: string): string | null {
  return Object.hasOwn(DOCS_SECTION_TITLES, slug) ? DOCS_SECTION_TITLES[slug as DocsSection] : null
}

/**
 * The docs are written in English only, so the whole docs area (layout,
 * search, pager, flow player, footer) is shown in English whatever the
 * UI language is. See app/composables/platform/useAreaI18n.ts.
 */
export const DOCS_LOCALE = 'en' as const

/** True for `/docs` and everything below it. */
export function isDocsPath(path: string): boolean {
  const pathname = path.split(/[?#]/)[0] ?? ''
  return pathname === '/docs' || pathname.startsWith('/docs/')
}

/** What the docs sidebar, pager and search need of a navigation node. */
export interface DocsNavNode {
  title: string
  path: string
  children?: DocsNavNode[]
  navHidden?: boolean
  order?: number
  icon?: string
  description?: string
}

/**
 * The section nodes of what `queryCollectionNavigation('docs')` returns:
 * a single root "Docs" node whose children are the sections.
 */
export function docsNavSections<T extends DocsNavNode>(nav: readonly T[] | null | undefined): T[] {
  if (!nav?.length) return []
  const only = nav.length === 1 ? nav[0] : undefined
  if (only?.children?.length) return only.children as T[]
  return [...nav]
}

/**
 * The entries of one sidebar level, in display order: hidden ones
 * dropped, `order` first (pages without one last), then by title.
 */
export function sortDocsNav<T extends DocsNavNode>(items: readonly T[] | undefined): T[] {
  if (!items) return []
  return items
    .filter(it => !it.navHidden)
    .sort((a, b) => {
      const ao = a.order ?? Number.MAX_SAFE_INTEGER
      const bo = b.order ?? Number.MAX_SAFE_INTEGER
      return ao === bo ? a.title.localeCompare(b.title) : ao - bo
    })
}

/**
 * The children the sidebar lists under `item`: sorted, without the entry
 * for the section's own index page (Nuxt Content returns folder/index.md
 * both as the group and as a child of itself).
 */
export function docsNavChildren<T extends DocsNavNode>(item: T): T[] {
  return sortDocsNav(item.children as T[] | undefined).filter(child => child.path !== item.path)
}

/**
 * The whole tree in sidebar order, level by level (search groups follow
 * it). A section's own index page stays its first child.
 */
export function sortDocsNavTree<T extends DocsNavNode>(items: readonly T[] | undefined): T[] {
  return sortDocsNav(items).map((item) => {
    if (!item.children) return item
    const own = (item.children as T[]).filter(child => child.path === item.path && !child.navHidden)
    return { ...item, children: [...own, ...sortDocsNavTree(docsNavChildren(item))] }
  })
}

/**
 * Every docs page in reading order, which is the sidebar read top to
 * bottom: a section's index page, then its pages by `order`, then the
 * next section. The prev / next pager walks this list.
 */
export function docsReadingOrder<T extends DocsNavNode>(items: readonly T[] | undefined): T[] {
  return sortDocsNav(items).flatMap(item => [item, ...docsReadingOrder(docsNavChildren(item))])
}

/** The pages before and after `path` in reading order (null at either end, or for an unknown path). */
export function docsPagerNeighbours<T extends DocsNavNode>(items: readonly T[] | undefined, path: string): [T | null, T | null] {
  const pages = docsReadingOrder(items)
  const at = pages.findIndex(page => page.path === path)
  if (at < 0) return [null, null]
  return [pages[at - 1] ?? null, pages[at + 1] ?? null]
}

/** Position of a docs path in the section list (for sorting pages of different sections). */
export function docsSectionIndex(path: string): number {
  const at = DOCS_SECTIONS.indexOf((path.split('/')[2] ?? '') as DocsSection)
  return at < 0 ? DOCS_SECTIONS.length : at
}
