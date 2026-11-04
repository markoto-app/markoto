import { queryCollection } from '@nuxt/content/server'
import {
  buildSitemapXml,
  docsRoutePath,
  marketingSitemapPages,
  sitemapBaseUrl,
  sitemapEntries
} from '../utils/sitemap'
import { resolveLegalSurfacesEnabled } from '../../shared/config/instance'

// sitemap.xml — hosted marketing site only (server/utils/sitemap.ts).
// 404 on every other instance and while NUXT_SITE_URL is unset.

export default defineEventHandler(async (event) => {
  const base = sitemapBaseUrl(process.env)
  if (!base) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const [docs, marketing] = await Promise.all([
    queryCollection(event, 'docs').select('path', 'updated').all(),
    queryCollection(event, 'marketing').select('path', 'reviewed', 'updated').all()
  ])
  const docsLastmod: Record<string, string> = {}
  for (const d of docs) if (d.updated) docsLastmod[docsRoutePath(d.path)] = d.updated
  const xml = buildSitemapXml(sitemapEntries(base, {
    docsPaths: docs.map(d => docsRoutePath(d.path)),
    docsLastmod,
    legalSurfaces: resolveLegalSurfacesEnabled(process.env),
    marketingPages: marketingSitemapPages(marketing)
  }))

  setResponseHeader(event, 'Content-Type', 'application/xml; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
  return xml
})
