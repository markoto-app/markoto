import { robotsTxt } from '../utils/robots'
import { sitemapBaseUrl } from '../utils/sitemap'
import { resolveSiteIndexable } from '../../shared/config/instance'

// robots.txt — documents and internal routes are not for crawlers
// (server/utils/robots.ts). Served by the app so every deployment shape
// (hosted, self-host) gets the same file. The hosted marketing site adds
// its `Sitemap:` line; a non-indexable instance (staging) disallows all.

export default defineEventHandler((event) => {
  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
  const base = sitemapBaseUrl(process.env)
  return robotsTxt({
    indexable: resolveSiteIndexable(process.env),
    sitemapUrl: base ? `${base}/sitemap.xml` : null
  })
})
