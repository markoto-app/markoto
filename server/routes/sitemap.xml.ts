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

  const docs = await queryCollection(event, 'docs').select('path').all()
  const xml = buildSitemapXml(sitemapEntries(base, {
    docsPaths: docs.map(d => docsRoutePath(d.path)),
    legalSurfaces: resolveLegalSurfacesEnabled(process.env),
    marketingPages: marketingSitemapPages()
  }))

  setResponseHeader(event, 'Content-Type', 'application/xml; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
  return xml
})
