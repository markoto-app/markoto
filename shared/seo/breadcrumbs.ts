// Breadcrumb trails of the public pages, for the BreadcrumbList JSON-LD
// (shared/seo/structuredData.ts) and the visible docs breadcrumb. Every
// trail starts at the home page and ends at the page itself. Pure.

import type { Crumb } from './structuredData'

const HOME_CRUMB: Crumb = Object.freeze({ name: 'Home', path: '/' })
const DOCS_CRUMB_NAME = 'Docs'

/** `getting-started` → `Getting started` (sentence case, like the docs sidebar). */
export function slugLabel(segment: string): string {
  const words = segment.replaceAll('-', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function trimPath(path: string): string {
  const pathname = path.split(/[?#]/)[0] ?? ''
  const trimmed = pathname.replace(/\/+$/, '')
  return trimmed || '/'
}

/**
 * `/docs/writing/tables` → Home › Docs › Writing › <page title>. Folder
 * crumbs use the slug label (what the visible breadcrumb shows); the
 * last one is the page's own title. `/docs` → Home › <title>.
 */
export function docsBreadcrumbs(path: string, pageTitle: string): Crumb[] {
  const parts = trimPath(path).split('/').filter(Boolean)
  const trail: Crumb[] = [HOME_CRUMB]
  if (parts.length <= 1) return [...trail, { name: pageTitle, path: '/docs' }]
  trail.push({ name: DOCS_CRUMB_NAME, path: '/docs' })
  for (let i = 1; i < parts.length; i++) {
    const segment = parts[i] ?? ''
    const crumbPath = `/${parts.slice(0, i + 1).join('/')}`
    trail.push({ name: i === parts.length - 1 ? pageTitle : slugLabel(segment), path: crumbPath })
  }
  return trail
}

/** Home › <page>: pages without a hub (pricing, use cases, legal). */
export function pageBreadcrumbs(path: string, pageTitle: string): Crumb[] {
  return [HOME_CRUMB, { name: pageTitle, path: trimPath(path) }]
}

/** Home › <hub> › <page>: a page listed by a hub (comparisons under /compare). */
export function hubBreadcrumbs(hub: Crumb, path: string, pageTitle: string): Crumb[] {
  return [HOME_CRUMB, hub, { name: pageTitle, path: trimPath(path) }]
}
