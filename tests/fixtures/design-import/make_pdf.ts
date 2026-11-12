/**
 * Builds the PDF fixtures for "Create a design from a document" with
 * headless Chromium (invented content only):
 *
 *   bun tests/fixtures/design-import/make_pdf.ts
 *
 *   report-cover.pdf: annual report: full-bleed navy cover with an
 *                         orange accent bar, Liberation Sans (an Arial
 *                         clone: not in the font registry, so it has to
 *                         be substituted), navy table header, running foot.
 *   brochure-modern.pdf: product brief: Work Sans headings (a registry
 *                         font: exact match), Noto Serif text, teal
 *                         accent, tinted call-out boxes, letter-spaced
 *                         uppercase eyebrows.
 *
 * Fonts: Liberation / Noto come from the host's fontconfig; Work Sans
 * from node_modules/@fontsource. Re-running produces equivalent files
 * (Chromium stamps a creation date, so not byte-identical).
 */
import { chromium } from '@playwright/test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const here = resolve(import.meta.dir)
const fontDir = resolve(here, '../../../node_modules/@fontsource/work-sans/files')

const REPORT = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 0 }
body { margin: 0; font-family: 'Liberation Sans'; color: #1C2733; font-size: 10pt; line-height: 1.5 }
.cover { height: 297mm; background: #0B2545; color: #fff; position: relative; break-after: page }
.cover .bar { position: absolute; left: 22mm; top: 120mm; width: 40mm; height: 4mm; background: #F28C28 }
.cover h1 { position: absolute; left: 22mm; top: 130mm; margin: 0; font-size: 34pt; line-height: 1.1; font-weight: 700 }
.cover p { position: absolute; left: 22mm; top: 175mm; margin: 0; font-size: 14pt; color: #C9D6E3 }
.cover .meta { top: 260mm; font-size: 10pt; letter-spacing: .08em; text-transform: uppercase }
.page { height: 297mm; box-sizing: border-box; padding: 25mm 22mm 20mm; position: relative }
h2 { color: #0B2545; font-size: 18pt; margin: 0 0 4mm; padding-bottom: 2mm; border-bottom: 1.5pt solid #F28C28 }
h3 { color: #0B2545; font-size: 12pt; margin: 6mm 0 2mm }
table { width: 100%; border-collapse: collapse; margin: 4mm 0 }
th { background: #0B2545; color: #fff; text-align: left; padding: 2mm 3mm; font-size: 9pt }
td { padding: 2mm 3mm; border-bottom: .5pt solid #C9D6E3; font-size: 9pt }
.foot { position: absolute; left: 22mm; right: 22mm; bottom: 10mm; font-size: 8pt; color: #6B7A89; display: flex; justify-content: space-between }
</style></head><body>
<section class="cover"><div class="bar"></div><h1>Annual report<br>2026</h1><p>Northwind Analytics</p><p class="meta">Prepared for the board · March 2027</p></section>
<section class="page">
<h2>A year of steady growth</h2>
<p>Revenue grew by 18 % to 42 million, driven by the logistics dashboards and the new forecasting service. Operating costs rose more slowly than revenue for the third year in a row.</p>
<h3>Highlights</h3>
<p>We opened offices in Lisbon and Tallinn, hired 64 people and moved every customer to the new data platform without downtime.</p>
<table><tr><th>Segment</th><th>2025</th><th>2026</th><th>Change</th></tr>
<tr><td>Dashboards</td><td>21.4</td><td>25.9</td><td>+21 %</td></tr>
<tr><td>Forecasting</td><td>8.2</td><td>10.6</td><td>+29 %</td></tr>
<tr><td>Consulting</td><td>6.0</td><td>5.5</td><td>−8 %</td></tr></table>
<h3>Outlook</h3>
<p>For 2027 we expect growth between 12 and 15 %, with most of it coming from customers who already use two or more of our products.</p>
<div class="foot"><span>Northwind Analytics · Annual report 2026</span><span>2</span></div>
</section></body></html>`

const BROCHURE = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: 'Work Sans'; font-weight: 400; src: url('file://${fontDir}/work-sans-latin-400-normal.woff2') }
@font-face { font-family: 'Work Sans'; font-weight: 600; src: url('file://${fontDir}/work-sans-latin-600-normal.woff2') }
@page { size: A4; margin: 20mm 20mm 22mm }
body { font-family: 'Noto Serif'; font-size: 10.5pt; line-height: 1.6; color: #1F2937 }
.eyebrow { font-family: 'Work Sans'; font-size: 8.5pt; letter-spacing: .14em; text-transform: uppercase; color: #0F766E; font-weight: 600 }
h1 { font-family: 'Work Sans'; font-weight: 600; font-size: 30pt; line-height: 1.1; margin: 2mm 0 6mm; color: #0B1F1D }
h2 { font-family: 'Work Sans'; font-weight: 600; font-size: 15pt; color: #0F766E; margin: 8mm 0 2mm }
.callout { background: #E6F4F1; border-left: 3pt solid #0F766E; padding: 3mm 5mm; margin: 5mm 0 }
ul { padding-left: 5mm } li::marker { color: #0F766E }
</style></head><body>
<div class="eyebrow">Product brief · Pellucid Labs</div>
<h1>Clear water, measured every minute</h1>
<p>Pellucid sensors sit in the intake pipe and report turbidity, temperature and conductivity to the plant's control room. Operators see a problem minutes after it starts instead of at the next lab sample.</p>
<h2>How it works</h2>
<p>Each sensor sends a reading every 60 seconds over the plant network. The dashboard compares it with the last 30 days and flags anything outside the usual band.</p>
<div class="callout">A typical plant needs four sensors: one at each intake, one after filtration and one at the outlet.</div>
<h2>What you get</h2>
<ul><li>Alerts within two minutes of a change</li><li>Monthly reports for the regulator</li><li>Five years of history, exportable as CSV</li></ul>
<h2>Pricing</h2>
<p>Sensors are leased per year, with installation and calibration included. Ask us for a quote for your plant.</p>
</body></html>`

const browser = await chromium.launch()
const dir = mkdtempSync(join(tmpdir(), 'design-import-'))
try {
  for (const [name, html] of [['report-cover.pdf', REPORT], ['brochure-modern.pdf', BROCHURE]] as const) {
    const file = join(dir, name.replace('.pdf', '.html'))
    writeFileSync(file, html)
    const page = await browser.newPage()
    await page.goto(`file://${file}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)
    await page.pdf({ path: join(here, name), printBackground: true, preferCSSPageSize: true })
    await page.close()
    console.log(`wrote ${join(here, name)}`)
  }
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
