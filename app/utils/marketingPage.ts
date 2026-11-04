import {
  MARKETING_LOCALES,
  marketingContentPath,
  parseMarketingRoute,
  type MarketingTarget
} from '~~/shared/seo/marketing'
import type { CompareData } from '~~/shared/seo/compare'

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

/**
 * Claim data of a comparison page (content/compare/<slug>.yml), or null
 * when there is no such file. Shared by `::compare-facts` and
 * `::compare-sources` (same async-data key, one query per page).
 */
export async function fetchCompareData(slug: string): Promise<CompareData | null> {
  const item = await queryCollection('compare').where('stem', '=', `compare/${slug}`).first()
  return item ? { name: item.name, rows: item.rows } : null
}
