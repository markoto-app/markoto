// One-shot comparison: do Playwright's direct per-page screenshots match
// rasterizing the page.pdf() output via poppler? Run against the dev stack
// (postgres + sync + nuxt all up). Drops artefacts in a per-run mkdtemp.
//
// Flow:
//   1. Insert/update a fixture doc with multi-page markdown via the
//      Hocuspocus sync-server (writes Y.js state through the proper path).
//   2. Mint a render-token and drive Chromium against /_internal/render.
//   3. Capture page.pdf() AND per-page screenshots in the SAME session.
//   4. Run pdftoppm at 144 DPI on the PDF to produce reference PNGs.
//   5. Report dimensions + per-pixel diff (mean abs delta + worst-channel
//      max delta, in 0-255 space) per page.
//
// Run: source .env && bun scripts/compare-pdf-vs-png.mjs
//
// Required env: JWT_SECRET (or NUXT_JWT_SECRET), INTERNAL_API_SECRET
// (or NUXT_INTERNAL_API_SECRET), DATABASE_URL. Optional: APP_URL,
// SYNC_URL. The script fails loudly if any required var is missing,
// it must not embed dev secrets as literals (sonar javascript:S6437,
// typescript:S2068, javascript:S5443).

import { chromium } from 'playwright'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import jwt from 'jsonwebtoken'
import { spawnSync } from 'node:child_process'
import { promises as fs, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const APP_URL = process.env.APP_URL || 'http://localhost:3000'
const SYNC_URL = process.env.SYNC_URL || 'ws://localhost:4001'
const JWT_SECRET = process.env.JWT_SECRET || process.env.NUXT_JWT_SECRET
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || process.env.NUXT_INTERNAL_API_SECRET
const DATABASE_URL = process.env.DATABASE_URL
if (!JWT_SECRET || !INTERNAL_SECRET || !DATABASE_URL) {
  console.error('[compare] missing required env vars.')
  console.error('  Required: JWT_SECRET (or NUXT_JWT_SECRET), INTERNAL_API_SECRET (or NUXT_INTERNAL_API_SECRET), DATABASE_URL.')
  console.error('  Tip: `set -a && source .env && set +a && bun scripts/compare-pdf-vs-png.mjs`')
  process.exit(1)
}
// mkdtempSync creates a 0700-mode directory with a unique random suffix,
// safe against /tmp squatting attacks that a fixed path is vulnerable to.
const OUT_DIR = mkdtempSync(path.join(tmpdir(), 'render-compare-'))
const DOC_ID = 'render-compare-fixture'

// 7 H2 sections × ~120 words each → reliably paginates to 3-4 pages on
// the default theme.
const SECTIONS = [
  'Introduction', 'Background', 'Methodology', 'Results',
  'Discussion', 'Limitations', 'Conclusion'
]
const LOREM = `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam.`

function buildMarkdown() {
  const parts = ['# Render comparison fixture\n\n']
  for (const s of SECTIONS) {
    parts.push(
      `## ${s}\n\n${LOREM}\n\n`,
      `${LOREM}\n\n- bullet one\n- bullet two\n- bullet three\n\n`
    )
  }
  return parts.join('')
}

async function ensureDoc() {
  // Insert the row directly so we don't depend on user auth. Anonymous,
  // open-edit: the print page only needs the doc to exist.
  const { Client } = await import('pg')
  const c = new Client({ connectionString: DATABASE_URL })
  await c.connect()
  await c.query(`
    INSERT INTO documents (doc_id, title, access_mode)
    VALUES ($1, $2, 'open-edit')
    ON CONFLICT (doc_id) DO NOTHING
  `, [DOC_ID, 'Render compare fixture'])
  await c.end()
}

async function seedYjsContent() {
  const ydoc = new Y.Doc()
  const awareness = new Awareness(ydoc)
  const token = jwt.sign(
    { docId: DOC_ID, userId: 'render-compare-script', userName: 'compare', readOnly: false },
    JWT_SECRET,
    { expiresIn: '5m' }
  )
  const provider = new HocuspocusProvider({
    url: SYNC_URL,
    name: DOC_ID,
    document: ydoc,
    awareness,
    token,
    WebSocketPolyfill: (await import('ws')).WebSocket
  })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sync timeout')), 15_000)
    provider.on('synced', () => {
      clearTimeout(t)
      resolve()
    })
  })
  const ytext = ydoc.getText('content')
  const md = buildMarkdown()
  // Replace any existing content with the fixture, deterministically.
  ydoc.transact(() => {
    if (ytext.length > 0) ytext.delete(0, ytext.length)
    ytext.insert(0, md)
  })
  // Wait long enough for sync server's flushSize/throttle to persist.
  await new Promise(r => setTimeout(r, 2000))
  provider.destroy()
  return md.length
}

async function captureBoth() {
  const renderToken = jwt.sign(
    { docId: DOC_ID, snapshotId: 0, scope: 'render' },
    INTERNAL_SECRET,
    { expiresIn: 60 }
  )
  const url = `${APP_URL}/_internal/render/${DOC_ID}?t=${encodeURIComponent(renderToken)}`

  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 1024 },
      deviceScaleFactor: 1.5
    })
    const page = await ctx.newPage()
    page.on('console', (m) => {
      if (m.type() === 'error') console.warn('[page]', m.text())
    })
    page.on('pageerror', e => console.warn('[pageerror]', e.message, '\n  stack:', e.stack))

    console.log(`[compare] navigating to ${url}`)
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
    console.log('[compare] waiting for paged.js…')
    await page.waitForFunction(
      () => globalThis.__pagedReady === true,
      null,
      { timeout: 60_000 }
    )
    const pageCount = await page.evaluate(() => globalThis.__pagedPageCount ?? 0)
    console.log(`[compare] paginated to ${pageCount} pages`)

    // Direct PNGs.
    const pageEls = page.locator('.pagedjs_page')
    const dim = []
    for (let i = 0; i < pageCount; i++) {
      const buf = await pageEls.nth(i).screenshot({ type: 'png' })
      const out = path.join(OUT_DIR, `direct-page-${i + 1}.png`)
      await fs.writeFile(out, buf)
      const box = await pageEls.nth(i).boundingBox()
      dim.push({ idx: i + 1, w: box?.width, h: box?.height, bytes: buf.byteLength })
    }
    console.log('[compare] direct PNG dimensions:', dim)

    // PDF.
    await page.emulateMedia({ media: 'print' })
    const pdfBytes = await page.pdf({ printBackground: true, preferCSSPageSize: true })
    await fs.writeFile(path.join(OUT_DIR, 'document.pdf'), pdfBytes)
    console.log(`[compare] wrote PDF (${pdfBytes.byteLength} bytes)`)

    return pageCount
  } finally {
    await browser.close()
  }
}

function rasterizePdf() {
  // pdftoppm at 144 DPI (matches our deviceScaleFactor=1.5 against an A4
  // page rendered at 96dpi base). -png keeps it lossless. Outputs
  // pdf-page-1.png, pdf-page-2.png, ...
  const r = spawnSync('pdftoppm', [
    '-r', '144',
    '-png',
    path.join(OUT_DIR, 'document.pdf'),
    path.join(OUT_DIR, 'pdf-page')
  ], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('pdftoppm failed')
}

async function compareImages(pageCount) {
  // Compare with Python + PIL if available; otherwise fall back to file
  // size only.
  const py = `
import sys, os
from PIL import Image
out = []
for i in range(1, ${pageCount} + 1):
    a = Image.open(f'${OUT_DIR}/direct-page-{i}.png').convert('RGB')
    b = Image.open(f'${OUT_DIR}/pdf-page-{i:01d}.png').convert('RGB')
    aw, ah = a.size
    bw, bh = b.size
    # Resize the smaller one's frame to compare like-for-like: page.pdf()
    # at 96dpi vs deviceScaleFactor=1.5 may give slightly different pixel
    # counts, even though the printed page area is identical.
    target = (min(aw, bw), min(ah, bh))
    a2 = a.resize(target)
    b2 = b.resize(target)
    pa = a2.load()
    pb = b2.load()
    n = target[0] * target[1]
    s = 0
    mx = 0
    for y in range(0, target[1], 4):
        for x in range(0, target[0], 4):
            ra,ga,ba = pa[x,y]
            rb,gb,bb = pb[x,y]
            d = abs(ra-rb)+abs(ga-gb)+abs(ba-bb)
            s += d
            if d > mx: mx = d
    sample = (target[0]//4) * (target[1]//4)
    print(f"page {i}: direct={aw}x{ah}  pdf={bw}x{bh}  mean_abs_delta(rgb-sum/3)={s/(sample*3):.2f}  worst_pixel_abs_sum={mx}")
`
  const r = spawnSync('python3', ['-c', py], { stdio: 'inherit' })
  if (r.status !== 0) console.warn('[compare] python diff failed (PIL not installed?)')
}

async function main() {
  // OUT_DIR was created at module load via mkdtempSync.
  console.log(`[compare] artefacts will land in ${OUT_DIR}`)
  console.log('[compare] ensuring fixture doc exists…')
  await ensureDoc()
  console.log('[compare] seeding multi-page markdown via Hocuspocus…')
  const len = await seedYjsContent()
  console.log(`[compare] wrote ${len} chars to ytext`)
  const pageCount = await captureBoth()
  console.log('[compare] rasterizing PDF via pdftoppm…')
  rasterizePdf()
  console.log('[compare] comparing pages…')
  await compareImages(pageCount)
  console.log(`\n[compare] artefacts in ${OUT_DIR}/`)
}

try {
  await main()
} catch (e) {
  console.error('[compare] FAILED:', e)
  process.exit(1)
}
