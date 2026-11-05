#!/usr/bin/env bun
// No horizontal page scroll on phones: loads every sitemap URL of a
// running instance (or the paths given) at 375 and 390 px in headless
// Chromium and reports pages wider than the viewport, with the outermost
// elements that stick out. Exits 1 on any overflow. Advisory, no CI job
// (docs/CHEATSHEET.md → "SEO + page speed").
//
//   bun scripts/check-overflow.ts http://127.0.0.1:3000 [/path …]

import { chromium } from '@playwright/test'

const args = process.argv.slice(2)
const base = (args[0] ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
const WIDTHS = [375, 390]

async function sitemapPaths(): Promise<string[]> {
  const xml = await (await fetch(`${base}/sitemap.xml`)).text()
  return [...new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1] ?? '/').pathname))]
}

const paths = args.length > 1 ? args.slice(1) : await sitemapPaths()
const browser = await chromium.launch()
let failures = 0
try {
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 800 } })
    const page = await context.newPage()
    for (const path of paths) {
      await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
      const result = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth
        const offenders: string[] = []
        for (const el of document.querySelectorAll('body *')) {
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 || rect.right <= vw + 1) continue
          const parentRight = el.parentElement?.getBoundingClientRect().right ?? 0
          if (parentRight > vw + 1) continue
          const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 3).join('.') : ''
          offenders.push(`<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}> right edge ${Math.round(rect.right)}px`)
        }
        return { vw, scrollWidth: document.documentElement.scrollWidth, offenders: offenders.slice(0, 5) }
      })
      if (result.scrollWidth > result.vw) {
        failures++
        console.log(`OVERFLOW ${width}px ${path}: page ${result.scrollWidth}px wide`)
        for (const o of result.offenders) console.log(`    ${o}`)
      }
    }
    await context.close()
  }
} finally {
  await browser.close()
}
console.log(`${paths.length} pages × ${WIDTHS.join('/')} px: ${failures} overflowing`)
if (failures) process.exit(1)
