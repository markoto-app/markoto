import {
  MARKETING_LOCALES,
  marketingContentPath,
  parseMarketingRoute,
  type MarketingTarget
} from '~~/shared/seo/marketing'

/**
 * The marketing content item for a route path plus the language versions
 * of the same slug (for hreflang), or null when there is no such page —
 * the catch-all route (pages/[...marketing].vue) answers 404 then.
 */
export async function fetchMarketingPage(path: string) {
  const target: MarketingTarget | null = parseMarketingRoute(path)
  if (!target) return null
  const [page, versions] = await Promise.all([
    queryCollection('marketing').path(marketingContentPath(target.locale, target.slug)).first(),
    queryCollection('marketing')
      .where('path', 'IN', MARKETING_LOCALES.map(l => marketingContentPath(l, target.slug)))
      .select('path', 'reviewed')
      .all()
  ])
  return page ? { target, page, versions } : null
}
