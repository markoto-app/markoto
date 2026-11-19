import { llmsDocuments } from '../utils/platform/llmsSources'
import { sitemapBaseUrl } from '../utils/platform/sitemap'

// llms.txt (llmstxt.org): summary + linked index of the public marketing
// pages and the user docs (server/utils/platform/llmsTxt.ts). Hosted
// marketing site only, like sitemap.xml: 404 on every other instance and
// while NUXT_SITE_URL is unset.

export default defineApiHandler({
  access: allow.public('llms.txt is read by crawlers and AI tools, which have no session; it lists only public pages'),
  handler: async ({ event }) => {
    const base = sitemapBaseUrl()
    if (!base) throw apiError('resource/not-found')
    const { index } = await llmsDocuments(base)
    setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
    setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
    return index
  }
})
