#!/usr/bin/env bun
// SEO audit of a running instance (local production build of the hosted
// shape: NUXT_MARKETING_SITE_ENABLED=true + a NUXT_SITE_URL).
//
//   bun scripts/seo-audit.ts http://127.0.0.1:3620 [--json out.json]
//
// Reads /sitemap.xml, fetches every URL in it (plus `/`), and checks the
// server-rendered HTML: title + description (present, unique, length),
// canonical, Open Graph + Twitter tags, <html lang>, hreflang, robots
// meta, one <h1>, heading order, <img> alt/width/height, JSON-LD (parses,
// types, duplicate @ids) and every internal link (no 4xx/5xx). Exits 1
// when a page has an error-level finding. No CI job runs it; see
// docs/CHEATSHEET.md.
//
// The sitemap's URLs use NUXT_SITE_URL's origin; requests go to the base
// URL given on the command line instead (the site URL's host name may
// not resolve on this machine).

import { JSDOM } from 'jsdom'
import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from '../shared/seo/meta'

interface PageReport {
  path: string
  status: number
  title: string
  description: string
  canonical: string
  ogType: string
  ogImage: string
  ogComplete: boolean
  twitterCard: string
  lang: string
  hreflang: number
  robots: string
  h1: number
  headingOrderOk: boolean
  imgIssues: number
  jsonLdTypes: string[]
  errors: string[]
  warnings: string[]
}

const args = process.argv.slice(2)
const base = (args.find(a => !a.startsWith('--')) ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined

const OG_REQUIRED = ['og:title', 'og:description', 'og:type', 'og:url', 'og:site_name', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt'] as const
const TWITTER_REQUIRED = ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'] as const

function toLocal(url: string, siteOrigin: string): string {
  return url.startsWith(siteOrigin) ? `${base}${url.slice(siteOrigin.length)}` : url
}

async function fetchText(url: string): Promise<{ status: number, text: string }> {
  const res = await fetch(url, { redirect: 'manual', headers: { accept: 'text/html' } })
  return { status: res.status, text: await res.text() }
}

function meta(doc: Document, key: string): string {
  const el = doc.querySelector(`meta[property="${key}"], meta[name="${key}"]`)
  return el?.getAttribute('content') ?? ''
}

function collectJsonLdIds(node: unknown, ids: string[], types: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdIds(item, ids, types)
    return
  }
  if (typeof node !== 'object' || node === null) return
  const record = node as Record<string, unknown>
  const type = record['@type']
  const id = record['@id']
  const keys = Object.keys(record)
  // A bare `{ "@id": … }` is a reference, not a definition.
  const isDefinition = typeof type === 'string' || keys.some(k => !k.startsWith('@'))
  if (typeof type === 'string') types.push(type)
  if (typeof id === 'string' && isDefinition && keys.length > 1) ids.push(id)
  for (const [k, v] of Object.entries(record)) if (k !== '@context') collectJsonLdIds(v, ids, types)
}

function auditPage(path: string, status: number, html: string): PageReport & { links: string[] } {
  const doc = new JSDOM(html).window.document
  const errors: string[] = []
  const warnings: string[] = []
  const title = doc.querySelector('title')?.textContent ?? ''
  const description = meta(doc, 'description')
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? ''
  if (!title) errors.push('no <title>')
  else if (title.length > MAX_TITLE_LENGTH) warnings.push(`title ${title.length} chars`)
  if (!description) errors.push('no meta description')
  else if (description.length > MAX_DESCRIPTION_LENGTH) warnings.push(`description ${description.length} chars`)
  if (!canonical) errors.push('no canonical')

  const missingOg = OG_REQUIRED.filter(k => !meta(doc, k))
  const missingTw = TWITTER_REQUIRED.filter(k => !meta(doc, k))
  if (missingOg.length) errors.push(`missing ${missingOg.join(', ')}`)
  if (missingTw.length) errors.push(`missing ${missingTw.join(', ')}`)
  const lang = doc.documentElement.getAttribute('lang') ?? ''
  if (!lang) errors.push('no <html lang>')
  const robots = meta(doc, 'robots')

  const h1 = doc.querySelectorAll('h1').length
  if (h1 !== 1) errors.push(`${h1} <h1>`)
  let prev = 0
  let headingOrderOk = true
  for (const h of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const level = Number(h.tagName.slice(1))
    if (prev && level > prev + 1) {
      headingOrderOk = false
      warnings.push(`heading jump h${prev}→h${level} ("${(h.textContent ?? '').trim().slice(0, 40)}")`)
    }
    prev = level
  }

  let imgIssues = 0
  for (const img of doc.querySelectorAll('img')) {
    const problems: string[] = []
    if (!img.hasAttribute('alt')) problems.push('alt')
    if (!img.hasAttribute('width') || !img.hasAttribute('height')) problems.push('width/height')
    if (problems.length) {
      imgIssues++
      warnings.push(`<img ${(img.getAttribute('src') ?? '').slice(0, 60)}> missing ${problems.join(' + ')}`)
    }
  }

  const jsonLdTypes: string[] = []
  const ids: string[] = []
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      collectJsonLdIds(JSON.parse(script.textContent ?? ''), ids, jsonLdTypes)
    } catch {
      errors.push('JSON-LD does not parse')
    }
  }
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dupes.length) warnings.push(`JSON-LD @id defined twice: ${[...new Set(dupes)].join(', ')}`)
  if (robots.includes('noindex')) warnings.push(`robots: ${robots}`)

  const links = [...doc.querySelectorAll('a[href]')]
    .map(a => a.getAttribute('href') ?? '')
    .filter(h => h.startsWith('/') && !h.startsWith('//'))
    .map(h => h.split('#')[0] ?? '')
    .filter(Boolean)

  return {
    path,
    status,
    title,
    description,
    canonical,
    ogType: meta(doc, 'og:type'),
    ogImage: meta(doc, 'og:image'),
    ogComplete: missingOg.length === 0 && missingTw.length === 0,
    twitterCard: meta(doc, 'twitter:card'),
    lang,
    hreflang: doc.querySelectorAll('link[rel="alternate"][hreflang]').length,
    robots,
    h1,
    headingOrderOk,
    imgIssues,
    jsonLdTypes: [...new Set(jsonLdTypes)],
    errors,
    warnings,
    links
  }
}

async function main(): Promise<void> {
  const sitemap = await fetchText(`${base}/sitemap.xml`)
  if (sitemap.status !== 200) throw new Error(`/sitemap.xml answered ${sitemap.status}`)
  const locs = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1] ?? '')
  const lastmods = [...sitemap.text.matchAll(/<lastmod>/g)].length
  const siteOrigin = new URL(locs[0] ?? base).origin
  const paths = [...new Set(locs.map(l => new URL(l).pathname))]

  const reports: PageReport[] = []
  const linkSources = new Map<string, string>()
  for (const path of paths) {
    const { status, text } = await fetchText(toLocal(`${siteOrigin}${path}`, siteOrigin))
    const { links, ...report } = auditPage(path, status, text)
    if (status !== 200) report.errors.unshift(`status ${status}`)
    reports.push(report)
    for (const link of links) if (!linkSources.has(link)) linkSources.set(link, path)
  }

  const broken: string[] = []
  for (const [link, from] of linkSources) {
    const res = await fetch(`${base}${link}`, { redirect: 'manual' })
    await res.body?.cancel()
    if (res.status >= 400) broken.push(`${link} (${res.status}, linked from ${from})`)
  }

  const titles = new Map<string, string[]>()
  const descriptions = new Map<string, string[]>()
  for (const r of reports) {
    titles.set(r.title, [...(titles.get(r.title) ?? []), r.path])
    descriptions.set(r.description, [...(descriptions.get(r.description) ?? []), r.path])
  }
  for (const r of reports) {
    if ((titles.get(r.title)?.length ?? 0) > 1) r.warnings.push('title shared with another page')
    if (r.description && (descriptions.get(r.description)?.length ?? 0) > 1) r.warnings.push('description shared with another page')
  }

  const row = (r: PageReport): string => [
    r.path,
    r.status,
    r.title.length,
    r.description.length,
    r.canonical ? 'y' : '-',
    r.ogType || '-',
    r.ogComplete ? 'y' : 'partial',
    r.twitterCard || '-',
    r.lang || '-',
    r.hreflang,
    r.robots || '-',
    r.h1,
    r.headingOrderOk ? 'y' : 'n',
    r.imgIssues,
    r.jsonLdTypes.join('+') || '-'
  ].join(' | ')
  console.log('path | status | title | desc | canon | og:type | og/tw | twitter:card | lang | hreflang | robots | h1 | headings | img issues | JSON-LD')
  for (const r of reports) console.log(row(r))
  console.log(`\n${reports.length} pages, ${lastmods} <lastmod>, ${linkSources.size} internal links checked, ${broken.length} broken`)
  for (const b of broken) console.log(`  BROKEN ${b}`)
  for (const r of reports) {
    for (const e of r.errors) console.log(`  ERROR ${r.path}: ${e}`)
    for (const w of r.warnings) console.log(`  warn  ${r.path}: ${w}`)
  }
  if (jsonOut) await Bun.write(jsonOut, JSON.stringify({ reports, broken, lastmods }, null, 2))
  if (broken.length || reports.some(r => r.errors.length)) process.exit(1)
}

await main()
