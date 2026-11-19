import { llmsDocuments } from '../utils/platform/llmsSources'
import { sitemapBaseUrl } from '../utils/platform/sitemap'

// llms-full.txt (llmstxt.org): the full text of the user docs in one
// Markdown file, Nuxt Content components removed
// (server/utils/platform/llmsTxt.ts). Hosted marketing site only, like
// llms.txt and sitemap.xml.

export default defineApiHandler({
  access: allow.public('llms-full.txt is read by crawlers and AI tools, which have no session; it holds only the public user docs'),
  handler: async ({ event }) => {
    const base = sitemapBaseUrl()
    if (!base) throw apiError('resource/not-found')
    const { full } = await llmsDocuments(base)
    setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
    setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
    return full
  }
})
