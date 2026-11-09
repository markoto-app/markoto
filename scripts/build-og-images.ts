#!/usr/bin/env bun
// Builds the Open Graph / Twitter cards (1200×630 JPEGs) in public/og/ —
// committed, nothing is generated at runtime. Each card is a small HTML
// page in the brand type (Fraunces 300 with optical sizing, Inter, JetBrains
// Mono — the same Fontsource packages the app serves, loaded from
// node_modules), screenshotted at 1200×630 by headless Chromium
// (@playwright/test) and converted to JPEG by ffmpeg.
//
// Re-run after `bun run tour:capture` refreshes the posters, or when a
// card's text changes. Needs `bun install` (fonts + Playwright's
// Chromium: `bunx playwright install chromium`) and ffmpeg.
//
//   bun scripts/build-og-images.ts                 # every card
//   bun scripts/build-og-images.ts pricing docs    # some cards
//
// Which page gets which card: shared/seo/ogImages.ts — keep its alt texts
// in step with the text drawn here. JPEG, not WebP: some link unfurlers
// ignore WebP og:image files.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const ROOT = resolve(import.meta.dir, '..')
const OUT = join(ROOT, 'public/og')

interface Card {
  file: string
  /** Tour scene whose light poster fills the lower right. */
  scene: string
  eyebrow: string
  title: string
  subtitle: string
}

export const CARDS: Record<string, Card> = {
  'default': {
    file: 'markoto.jpg',
    scene: 'write',
    eyebrow: 'MARKOTO',
    title: 'Collaborative Markdown',
    subtitle: 'Write plain text; export a PDF that matches the preview page for page.'
  },
  'pricing': {
    file: 'pricing.jpg',
    scene: 'write',
    eyebrow: 'MARKOTO · PRICING',
    title: 'Pricing',
    subtitle: 'Self-hosted, no account, a free account or a paid plan.'
  },
  'use-cases': {
    file: 'use-cases.jpg',
    scene: 'themes',
    eyebrow: 'MARKOTO',
    title: 'Markdown with real pages',
    subtitle: 'A live paged preview, and a PDF that matches it page for page.'
  },
  'compare': {
    file: 'compare.jpg',
    scene: 'collab',
    eyebrow: 'MARKOTO · COMPARE',
    title: 'markoto compared',
    subtitle: 'How it compares with other editors, with a source for every fact.'
  },
  'docs': {
    file: 'docs.jpg',
    scene: 'rich',
    eyebrow: 'MARKOTO · DOCS',
    title: 'Documentation',
    subtitle: 'Guides, walkthroughs and reference for markoto.'
  }
}

function fileUrl(path: string): string {
  return pathToFileURL(join(ROOT, path)).href
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** The card as a self-contained page (fonts + poster from the checkout). */
function cardHtml(card: Card): string {
  // Brand tokens (app/assets/css/main.css): bone page, sumi ink, shu seal.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="${fileUrl('node_modules/@fontsource-variable/fraunces/opsz.css')}">
<link rel="stylesheet" href="${fileUrl('node_modules/@fontsource-variable/inter/index.css')}">
<link rel="stylesheet" href="${fileUrl('node_modules/@fontsource-variable/jetbrains-mono/index.css')}">
<style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #FAF8F4; }
  body { position: relative; color: #14110D; -webkit-font-smoothing: antialiased; }
  .eyebrow {
    position: absolute; left: 64px; top: 64px;
    display: flex; align-items: center; gap: 14px;
    font-family: 'JetBrains Mono Variable', monospace; font-weight: 400;
    font-size: 19px; letter-spacing: 0.06em; color: #6F675B;
  }
  .seal { width: 14px; height: 14px; border-radius: 2px; background: #B5371F; }
  h1 {
    position: absolute; left: 60px; top: 96px; margin: 0;
    font-family: 'Fraunces Variable', serif; font-weight: 300;
    font-optical-sizing: auto; font-size: 72px; line-height: 1.05;
    letter-spacing: -0.02em; white-space: nowrap;
  }
  p {
    position: absolute; left: 64px; top: 196px; margin: 0;
    font-family: 'Inter Variable', sans-serif; font-weight: 400;
    font-size: 27px; color: #6F675B; white-space: nowrap;
  }
  img {
    position: absolute; left: 200px; top: 262px; width: 1000px; height: auto;
    border: 1px solid #E2DDD2; border-right: 0; border-bottom: 0; border-top-left-radius: 6px;
  }
</style></head>
<body>
  <div class="eyebrow"><span class="seal"></span>${escapeHtml(card.eyebrow)}</div>
  <h1>${escapeHtml(card.title)}</h1>
  <p>${escapeHtml(card.subtitle)}</p>
  <img src="${fileUrl(`public/tour/light/${card.scene}/poster-1920.webp`)}" alt="">
</body></html>`
}

async function main(): Promise<void> {
  const names = process.argv.slice(2)
  const selected = names.length ? names : Object.keys(CARDS)
  for (const name of selected) {
    if (!CARDS[name]) throw new Error(`unknown card: ${name} (one of ${Object.keys(CARDS).join(', ')})`)
  }
  const tmp = mkdtempSync(join(tmpdir(), 'markoto-og-'))
  // Unhinted glyph advances, like the PDF renderer (renderer/src/render.ts).
  const browser = await chromium.launch({ args: ['--font-render-hinting=none'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
    for (const name of selected) {
      const card = CARDS[name]
      if (!card) continue
      const htmlPath = join(tmp, `${name}.html`)
      await Bun.write(htmlPath, cardHtml(card))
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      const png = join(tmp, `${name}.png`)
      await page.screenshot({ path: png, clip: { x: 0, y: 0, width: 1200, height: 630 } })
      const out = join(OUT, card.file)
      const ffmpeg = Bun.spawnSync(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', png, '-q:v', '3', '-frames:v', '1', out])
      if (ffmpeg.exitCode !== 0) throw new Error(`ffmpeg failed for ${card.file}: ${ffmpeg.stderr.toString()}`)
      console.log(`wrote public/og/${card.file}`)
    }
  } finally {
    await browser.close()
    rmSync(tmp, { recursive: true, force: true })
  }
}

await main()
