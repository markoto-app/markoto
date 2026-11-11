import {
  DEFAULT_MARKETING_LOCALE,
  MARKETING_LOCALES,
  marketingRoutePath,
  parseMarketingContentPath,
  type MarketingLocale
} from '~~/shared/seo/marketing'

export interface MarketingNavLink {
  label: string
  to: string
}

export interface MarketingNav {
  useCases: MarketingNavLink[]
  compare: MarketingNavLink[]
  /** The templates hub (navOrder 0) first, then one page per template. */
  templates: MarketingNavLink[]
}

type NavGroup = keyof MarketingNav

const EMPTY: MarketingNav = { useCases: [], compare: [], templates: [] }

const GROUP_OF: Record<string, NavGroup> = {
  'use-cases': 'useCases',
  'compare': 'compare',
  'templates': 'templates'
}

function asMarketingLocale(code: string): MarketingLocale {
  return MARKETING_LOCALES.find(l => l === code) ?? DEFAULT_MARKETING_LOCALE
}

/**
 * Header + footer menus of the marketing site, built from the `marketing`
 * content collection (`navGroup` / `navLabel` / `navOrder` frontmatter of
 * the English pages). A page links to its version in the current UI
 * language when one exists and is reviewed, under that version's own
 * `navLabel` (or title). Empty off the marketing site
 * (the pages 404 there) — no query is made.
 */
export function useMarketingNav() {
  const { marketingSite } = useInstanceConfig()
  const { locale } = useI18n()

  const { data } = useAsyncData('marketing:nav', async () => {
    if (!marketingSite.value) return []
    return await queryCollection('marketing')
      .select('path', 'navGroup', 'navLabel', 'navOrder', 'reviewed', 'title')
      .all()
  }, { default: () => [] })

  return computed<MarketingNav>(() => {
    const items = data.value
    if (!marketingSite.value || items.length === 0) return EMPTY
    const current = asMarketingLocale(locale.value)
    // Reviewed versions with their own label, so a link to the German page reads in German.
    const translated = new Map<string, string>()
    for (const item of items) {
      const target = parseMarketingContentPath(item.path)
      if (target && item.reviewed !== false) translated.set(`${target.locale}:${target.slug}`, item.navLabel ?? item.title)
    }
    type Ordered = MarketingNavLink & { order: number }
    const nav: Record<NavGroup, Ordered[]> = { useCases: [], compare: [], templates: [] }
    for (const item of items) {
      const target = parseMarketingContentPath(item.path)
      const group = item.navGroup ? GROUP_OF[item.navGroup] : undefined
      if (!target || target.locale !== DEFAULT_MARKETING_LOCALE || !group) continue
      const localisedLabel = translated.get(`${current}:${target.slug}`)
      const locale = localisedLabel === undefined ? DEFAULT_MARKETING_LOCALE : current
      const link = {
        label: localisedLabel ?? item.navLabel ?? item.title,
        to: marketingRoutePath(locale, target.slug),
        order: item.navOrder ?? Number.MAX_SAFE_INTEGER
      }
      nav[group].push(link)
    }
    const sorted = (links: Ordered[]): MarketingNavLink[] => links
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
      .map(({ label, to }) => ({ label, to }))
    return { useCases: sorted(nav.useCases), compare: sorted(nav.compare), templates: sorted(nav.templates) }
  })
}
