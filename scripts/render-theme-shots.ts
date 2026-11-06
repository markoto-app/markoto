#!/usr/bin/env bun
/**
 * Theme shots: render one Markdown file in several theme presets through
 * the REAL preview (editor page → sandboxed paged.js iframe) and save a
 * PNG per page plus a contact sheet per preset. For reviewing theme /
 * pagination changes page by page (`make theme-shots`).
 *
 *   bun scripts/render-theme-shots.ts --base http://localhost:3000 \
 *     --out /tmp/shots --md tests/fixtures/theme-shots/kitchen-sink.md \
 *     [--title "Doc title"] [--patch theme-patch.json] markoto academic …
 *
 * No preset ids = every built-in preset. `--patch` is a JSON object merged
 * (two levels deep, like the AI `update_theme`) over each preset before
 * the document opens — e.g. authors/affiliations for a title block. It is
 * written with `PUT /api/docs/:id/meta`, which needs the owner, so with
 * `--patch` the documents are created as user 1 through the test login
 * shim: only on a TEST_MODE=1 instance whose database has that user.
 *
 * Needs a running app (a production build is closest to what users see)
 * that lets anonymous visitors create documents without the terms step:
 * start it with NUXT_ANON_GATE_ENABLED=false. Nothing else (no sync
 * server login, no renderer) — the pages come from the browser preview,
 * which shares `themeToCss` with the server PDF.
 *
 * Output per preset: `<out>/<preset>-p<N>.png` (2× scale), `<preset>.html`
 * (the paginated document with its CSS, standalone) and `sheet-<preset>.png`
 * (four pages per row; `sheet-<preset>-b.png` for pages 5+).
 */
import { chromium, type BrowserContext } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { THEME_PRESETS } from '../shared/utils/themePresets'
import type { DocTheme } from '../shared/types/theme'

interface Args {
  base: string
  out: string
  md: string
  title: string
  patch: Record<string, unknown> | null
  presets: string[]
}

function parseArgs(argv: string[]): Args {
  const opts = new Map<string, string>()
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a.startsWith('--')) {
      opts.set(a.slice(2), argv[i + 1] ?? '')
      i++
    } else {
      rest.push(a)
    }
  }
  const base = opts.get('base')
  const out = opts.get('out')
  const md = opts.get('md')
  if (!base || !out || !md) {
    console.error('usage: render-theme-shots.ts --base <url> --out <dir> --md <file.md> [--title <t>] [--patch <json file>] [preset …]')
    process.exit(2)
  }
  const patchFile = opts.get('patch')
  let patch: Record<string, unknown> | null = null
  if (patchFile) {
    const parsed: unknown = JSON.parse(readFileSync(patchFile, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('--patch must hold a JSON object')
    patch = { ...parsed }
  }
  return {
    base: base.replace(/\/$/, ''),
    out: resolve(out),
    md,
    title: opts.get('title') ?? 'Edge cache behaviour under partitions',
    patch,
    presets: rest.length ? rest : THEME_PRESETS.map(p => p.id)
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Two-level merge (section → field), the same shape as the AI theme patch. */
function patchTheme(theme: DocTheme, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...theme }
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    out[key] = isRecord(value) && isRecord(current) ? { ...current, ...value } : value
  }
  return out
}

async function createDoc(args: Args, content: string, presetId: string): Promise<string> {
  // With a patch the document belongs to the test user (theme writes need
  // an owner); otherwise it is an anonymous document.
  const cookie = args.patch ? await testSession(args.base) : ''
  const headers = { 'content-type': 'application/json', 'origin': args.base, ...(cookie ? { cookie } : {}) }
  const res = await fetch(`${args.base}/api/docs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content, title: args.title, themePreset: presetId })
  })
  if (!res.ok) throw new Error(`POST /api/docs → ${res.status} ${await res.text()} (is NUXT_ANON_GATE_ENABLED=false?)`)
  const body: unknown = await res.json()
  const docId = isRecord(body) ? body.docId : undefined
  if (typeof docId !== 'string') throw new Error('POST /api/docs returned no docId')
  const preset = THEME_PRESETS.find(p => p.id === presetId)
  if (args.patch && preset) {
    const put = await fetch(`${args.base}/api/docs/${docId}/meta`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ theme: patchTheme(preset.theme, args.patch) })
    })
    if (!put.ok) throw new Error(`PUT meta → ${put.status} ${await put.text()}`)
  }
  return docId
}

let sessionCookie: string | null = null

/** Session cookie from `/api/_test/login` (TEST_MODE=1 instances only). */
async function testSession(base: string): Promise<string> {
  if (sessionCookie) return sessionCookie
  const res = await fetch(`${base}/api/_test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'origin': base },
    body: JSON.stringify({ userId: 1, name: 'Theme shots' })
  })
  if (!res.ok) throw new Error(`--patch needs a TEST_MODE=1 instance with user 1 (test login shim): /api/_test/login → ${res.status}`)
  sessionCookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  return sessionCookie
}

/** Give the browser the same session (the patched documents are the test user's). */
async function shareSession(ctx: BrowserContext, base: string): Promise<void> {
  if (!sessionCookie) return
  const url = new URL(base)
  await ctx.addCookies(sessionCookie.split('; ').flatMap((pair) => {
    const eq = pair.indexOf('=')
    return eq > 0 ? [{ name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: url.hostname, path: '/' }] : []
  }))
}

/** Copy the paginated document out of the opaque-origin preview frame as standalone HTML. */
async function capturePreview(ctx: BrowserContext, base: string, docId: string): Promise<string> {
  const page = await ctx.newPage()
  await page.goto(`${base}/d/${docId}`, { waitUntil: 'networkidle' })
  const frame = page.frameLocator('iframe').first()
  await frame.locator('#mount .pagedjs_page').first().waitFor({ timeout: 60_000 })
  // Mermaid, web fonts, KaTeX and the debounced re-render settle.
  await page.waitForTimeout(4000)
  const html = await frame.locator('html').evaluate((el) => {
    const sheets: string[] = []
    for (const s of Array.from(el.ownerDocument.styleSheets)) {
      try {
        sheets.push(`<style>${Array.from(s.cssRules).map(r => r.cssText).join('\n')}</style>`)
      } catch {
        if (s.href) sheets.push(`<link rel="stylesheet" href="${s.href}">`)
      }
    }
    const clone = el.cloneNode(true)
    if (!(clone instanceof Element)) return ''
    clone.querySelectorAll('script, style, link[rel="stylesheet"]').forEach(s => s.remove())
    clone.querySelector('#pending')?.remove()
    clone.querySelectorAll('.pagedjs_pages').forEach((e) => {
      if (e instanceof HTMLElement) e.style.zoom = ''
    })
    // paged.js stores `string-set` values (the `{section}` token) as
    // `--pagedjs-string-*: "text` with no closing quote. Live, the CSSOM
    // keeps each property apart; re-parsed from the style attribute the
    // open string swallows the next declarations. Close the strings.
    clone.querySelectorAll('.pagedjs_page').forEach((e) => {
      if (!(e instanceof HTMLElement)) return
      for (const name of Array.from(e.style)) {
        if (!name.startsWith('--pagedjs-string-')) continue
        const value = e.style.getPropertyValue(name).trim()
        if (value.startsWith('"') && (value.length === 1 || !value.endsWith('"'))) e.style.setProperty(name, `${value}"`)
      }
    })
    clone.querySelector('head')?.insertAdjacentHTML('beforeend', sheets.join(''))
    return `<!doctype html>${clone.outerHTML}`
  })
  await page.close()
  return html
}

async function shootPages(ctx: BrowserContext, base: string, html: string, out: string, id: string): Promise<string[]> {
  const page = await ctx.newPage()
  // Same origin as the app, so the /vendor/ fonts + stylesheets resolve.
  await page.goto(`${base}/robots.txt`)
  await page.setContent(html, { waitUntil: 'networkidle' })
  await page.addStyleTag({ content: 'html,body{background:#cfcac0!important} .pagedjs_page{margin:0 auto 16px!important}' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(500)
  const pages = page.locator('#mount .pagedjs_page')
  const n = await pages.count()
  const files: string[] = []
  for (let i = 0; i < n; i++) {
    const f = `${id}-p${i + 1}.png`
    await pages.nth(i).screenshot({ path: `${out}/${f}` })
    files.push(f)
  }
  await page.close()
  return files
}

async function contactSheets(ctx: BrowserContext, out: string, id: string, files: string[]): Promise<void> {
  const page = await ctx.newPage()
  await page.setViewportSize({ width: 2000, height: 900 })
  const rows = [files.slice(0, 4), files.slice(4)].filter(r => r.length > 0)
  for (const [i, row] of rows.entries()) {
    const width = Math.min(480, Math.floor(1960 / Math.min(Math.max(files.length, 1), 4)) - 10)
    const html = `<!doctype html><style>body{margin:0;padding:12px;background:#cfcac0;display:flex;gap:10px}img{width:${width}px;display:block;background:#fff}</style>${row.map(f => `<img src="file://${out}/${f}">`).join('')}`
    const sheet = `${out}/_sheet-${id}-${i}.html`
    writeFileSync(sheet, html)
    await page.goto(`file://${sheet}`)
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${out}/sheet-${id}${i === 0 ? '' : '-b'}.png`, fullPage: true })
  }
  await page.close()
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const content = readFileSync(args.md, 'utf8')
  mkdirSync(args.out, { recursive: true })
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1800, height: 1100 }, deviceScaleFactor: 2 })
  const sheetCtx = await browser.newContext({ deviceScaleFactor: 1 })
  try {
    for (const id of args.presets) {
      const docId = await createDoc(args, content, id)
      await shareSession(ctx, args.base)
      const html = await capturePreview(ctx, args.base, docId)
      writeFileSync(`${args.out}/${id}.html`, html)
      const files = await shootPages(ctx, args.base, html, args.out, id)
      await contactSheets(sheetCtx, args.out, id, files)
      console.log(`${id}: ${files.length} pages (doc ${docId})`)
    }
  } finally {
    await browser.close()
  }
}

await main()
