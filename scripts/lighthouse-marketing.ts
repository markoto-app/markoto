#!/usr/bin/env bun
// Lighthouse (mobile profile, simulated throttling) against the public
// marketing pages of a running instance — ideally a local production
// build of the hosted shape (NUXT_MARKETING_SITE_ENABLED=true). Advisory:
// no CI job runs it. See docs/CHEATSHEET.md ("SEO + page speed").
//
//   bun scripts/lighthouse-marketing.ts http://127.0.0.1:3620 [/path …]
//
// Lighthouse is NOT a repo dependency: it runs through `bunx` (pinned
// below), downloaded into Bun's cache on first use. Needs a Chrome or
// Chromium; set CHROME_PATH when it isn't found on its own (Playwright's
// copy works: ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome).
// Reports land in $LIGHTHOUSE_OUT (default: a temp dir).

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIGHTHOUSE = 'lighthouse@12.8.2'
const DEFAULT_PATHS = ['/', '/pricing', '/markdown-to-pdf', '/compare/hackmd']

const args = process.argv.slice(2)
const base = (args[0] ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
const paths = args.length > 1 ? args.slice(1) : DEFAULT_PATHS
const outDir = process.env.LIGHTHOUSE_OUT ?? mkdtempSync(join(tmpdir(), 'markoto-lh-'))

interface Audit { numericValue?: number, displayValue?: string, score?: number | null, title?: string, details?: { overallSavingsMs?: number, items?: Array<Record<string, unknown>> } }
interface Report { categories: Record<string, { score: number | null }>, audits: Record<string, Audit> }

function isReport(value: unknown): value is Report {
  return typeof value === 'object' && value !== null && 'audits' in value && 'categories' in value
}

function scriptBytes(audit: Audit | undefined): number {
  let total = 0
  for (const item of audit?.details?.items ?? []) {
    if (item.resourceType === 'Script' && typeof item.transferSize === 'number') total += item.transferSize
  }
  return total
}

const rows: string[] = []
for (const path of paths) {
  const slug = path === '/' ? 'home' : path.replace(/^\/+/, '').replaceAll('/', '_')
  const output = join(outDir, `${slug}.json`)
  const proc = Bun.spawnSync([
    'bun', 'x', LIGHTHOUSE, `${base}${path}`,
    '--quiet',
    '--only-categories=performance,seo,accessibility,best-practices',
    '--chrome-flags=--headless=new --no-sandbox',
    '--output=json', `--output-path=${output}`
  ], { stdout: 'inherit', stderr: 'inherit' })
  if (proc.exitCode !== 0) {
    rows.push(`${path} | lighthouse failed (exit ${proc.exitCode})`)
    continue
  }
  const report: unknown = await Bun.file(output).json()
  if (!isReport(report)) {
    rows.push(`${path} | unreadable report`)
    continue
  }
  const a = report.audits
  const score = (key: string): string => String(Math.round((report.categories[key]?.score ?? 0) * 100))
  const ms = (key: string): string => `${Math.round(a[key]?.numericValue ?? 0)}`
  const opportunities = Object.values(a)
    .filter(x => (x.details?.overallSavingsMs ?? 0) >= 100)
    .sort((x, y) => (y.details?.overallSavingsMs ?? 0) - (x.details?.overallSavingsMs ?? 0))
    .slice(0, 3)
    .map(x => `${x.title} (${Math.round(x.details?.overallSavingsMs ?? 0)} ms)`)
  rows.push([
    path,
    score('performance'),
    ms('first-contentful-paint'),
    ms('largest-contentful-paint'),
    (a['cumulative-layout-shift']?.numericValue ?? 0).toFixed(3),
    ms('total-blocking-time'),
    `${Math.round(scriptBytes(a['network-requests']) / 1024)} KB`,
    `${Math.round((a['total-byte-weight']?.numericValue ?? 0) / 1024)} KB`,
    score('seo'),
    score('accessibility'),
    opportunities.join('; ') || '-'
  ].join(' | '))
}

console.log('\npath | perf | FCP ms | LCP ms | CLS | TBT ms | JS transferred | total transferred | SEO | a11y | top opportunities')
for (const row of rows) console.log(row)
console.log(`\nreports: ${outDir}`)
