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
