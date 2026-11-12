import { robotsTxt } from '../utils/platform/robots'
import { sitemapBaseUrl } from '../utils/platform/sitemap'
import { resolveSiteIndexable } from '../../shared/config/instance'

// robots.txt: documents and internal routes are not for crawlers
// (server/utils/platform/robots.ts). Served by the app so every deployment shape
// (hosted, self-host) gets the same file. The hosted marketing site adds
// its `Sitemap:` line; a non-indexable instance (staging) disallows all.

export default defineApiHandler({
  access: allow.public('robots.txt is read by crawlers, which have no session'),
  handler: ({ event }) => {
    setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
    setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
    const base = sitemapBaseUrl()
    return robotsTxt({
      indexable: resolveSiteIndexable(),
      sitemapUrl: base ? `${base}/sitemap.xml` : null
    })
  }
})
