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
}

const EMPTY: MarketingNav = { useCases: [], compare: [] }

function asMarketingLocale(code: string): MarketingLocale {
  return MARKETING_LOCALES.find(l => l === code) ?? DEFAULT_MARKETING_LOCALE
}

/**
 * Header + footer menus of the marketing site, built from the `marketing`
 * content collection (`navGroup` / `navLabel` / `navOrder` frontmatter of
 * the English pages). A page links to its version in the current UI
 * language when one exists and is reviewed. Empty off the marketing site
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
    const translated = new Set<string>()
    for (const item of items) {
      const target = parseMarketingContentPath(item.path)
      if (target && item.reviewed !== false) translated.add(`${target.locale}:${target.slug}`)
    }
    const nav: { useCases: Array<MarketingNavLink & { order: number }>, compare: Array<MarketingNavLink & { order: number }> } = { useCases: [], compare: [] }
    for (const item of items) {
      const target = parseMarketingContentPath(item.path)
      if (!target || target.locale !== DEFAULT_MARKETING_LOCALE || !item.navGroup) continue
      const locale = translated.has(`${current}:${target.slug}`) ? current : DEFAULT_MARKETING_LOCALE
      const link = {
        label: item.navLabel ?? item.title,
        to: marketingRoutePath(locale, target.slug),
        order: item.navOrder ?? Number.MAX_SAFE_INTEGER
      }
      if (item.navGroup === 'use-cases') nav.useCases.push(link)
      else nav.compare.push(link)
    }
    const sorted = (links: Array<MarketingNavLink & { order: number }>): MarketingNavLink[] => links
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
      .map(({ label, to }) => ({ label, to }))
    return { useCases: sorted(nav.useCases), compare: sorted(nav.compare) }
  })
}
