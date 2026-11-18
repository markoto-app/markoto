// The admin area's pages, in navigation order: the sub-navigation of
// `layouts/admin.vue` and the cards of the hub (`/admin`) both read this
// list, so a new admin page needs one entry here.

export const ADMIN_SECTIONS = [
  { key: 'overview', to: '/admin', icon: 'i-lucide-layout-dashboard' },
  { key: 'stats', to: '/admin/stats', icon: 'i-lucide-chart-line' },
  { key: 'investor', to: '/admin/stats/investor', icon: 'i-lucide-presentation' },
  { key: 'aiSpend', to: '/admin/ai-spend', icon: 'i-lucide-receipt' },
  { key: 'abuseReports', to: '/admin/abuse-reports', icon: 'i-lucide-flag' }
] as const

export type AdminSectionKey = typeof ADMIN_SECTIONS[number]['key']

/** The section a path belongs to: the longest matching prefix wins. */
export function adminSectionOf(path: string): AdminSectionKey | null {
  const clean = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  const match = ADMIN_SECTIONS
    .filter(s => clean === s.to || (s.to !== '/admin' && clean.startsWith(`${s.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)[0]
  return match?.key ?? null
}
