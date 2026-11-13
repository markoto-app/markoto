#!/usr/bin/env bun
// Live-preview performance probe: keystroke → repainted preview latency,
// parent main-thread blocking, and browser memory, for two realistic
// documents. Used to compare preview-iframe implementations (e.g. the
// same-origin iframe vs the sandboxed null-origin iframe) on the same
// machine.
//
// Needs a running app with TEST_MODE=1 + NUXT_PUBLIC_EXPOSE_TEST_HANDLES=1
// on top of the flow test stack (deploy/compose/compose.test.yml, Postgres on
// :5433), e.g. `FLOWS_SERVE_ONLY=1 bun run flows:test`. Then:
//
//   PERF_BASE_URL=http://localhost:3001 bun scripts/measure-preview-perf.ts [label]
//
// Env: PERF_ITERATIONS (default 15), PERF_HEADED=1 to watch it run.
//
// What one sample measures: the last keydown of a short marker word typed
// at the end of the document (parent page clock) → the moment the preview
// iframe's visible `#mount` first contains the marker (iframe clock). Both
// clocks are `performance.timeOrigin + performance.now()`, i.e. wall time
// with sub-millisecond resolution, so they compare across documents. The
// figure includes the preview's 250 ms render debounce.

import { readdirSync, readFileSync } from 'node:fs'
import { chromium, type Frame, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { PRIVACY_VERSION, TOS_VERSION, DPA_VERSION } from '../shared/legal/versions'

// The Demo template: the content a new document opens with by default.
const demoMarkdown = readFileSync(new URL('../shared/templates/content/demo/en.md', import.meta.url), 'utf-8')

const BASE_URL = process.env.PERF_BASE_URL ?? 'http://localhost:3001'
const ITERATIONS = Number(process.env.PERF_ITERATIONS ?? 15)
const LABEL = process.argv[2] ?? 'run'
const PG_URL = process.env.PERF_DATABASE_URL ?? 'postgres://ypad:testpassword@localhost:5433/ypad_test'

interface Sample { latencyMs: number, parentLongTaskMs: number }

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx] ?? Number.NaN
}

async function createUser(): Promise<number> {
  const pool = new Pool({ connectionString: PG_URL, max: 1 })
  try {
    const res = await pool.query<{ id: number }>(
      `INSERT INTO users (github_id, name, plan, age_confirmed_at,
         privacy_version_accepted, privacy_version_accepted_locale,
         tos_version_accepted, tos_version_accepted_locale,
         dpa_version_accepted, dpa_version_accepted_locale)
       VALUES ($1, 'Perf probe', 'free', NOW(), $2, 'en', $3, 'en', $4, 'en')
       RETURNING id`,
      [`perf-probe-${Date.now()}`, PRIVACY_VERSION, TOS_VERSION, DPA_VERSION]
    )
    const row = res.rows[0]
    if (!row) throw new Error('user insert returned no row')
    return row.id
  } finally {
    await pool.end()
  }
}

async function sessionCookie(userId: number): Promise<{ name: string, value: string }> {
  const res = await fetch(`${BASE_URL}/api/_test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'origin': BASE_URL },
    body: JSON.stringify({ userId, name: 'Perf probe' })
  })
  const setCookie = res.headers.get('set-cookie')
  if (!res.ok || !setCookie) throw new Error(`login failed: ${res.status}`)
  const first = setCookie.split(';')[0] ?? ''
  const eq = first.indexOf('=')
  return { name: first.slice(0, eq), value: first.slice(eq + 1) }
}

/** Creates a private doc owned by the logged-in user and uploads one PNG into it. */
async function createDocWithImage(page: Page): Promise<{ docId: string, imageUrl: string }> {
  const png = readFileSync(new URL('../public/icon-512.png', import.meta.url)).toString('base64')
  return page.evaluate(async (pngBase64) => {
    const json = async (url: string, body: unknown) => {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error(`${url} → ${r.status}`)
      return r.json()
    }
    const doc = await json('/api/docs', { title: 'Preview perf probe' })
    const docId: string = doc.id ?? doc.docId
    const bytes = Uint8Array.from(atob(pngBase64), c => c.codePointAt(0) ?? 0)
    const req = await json('/api/upload/request', { docId, filename: 'probe.png', contentType: 'image/png', size: bytes.length })
    const put = await fetch(req.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes })
    if (!put.ok) throw new Error(`S3 PUT → ${put.status}`)
    await json('/api/upload/confirm', { key: req.key })
    return { docId, imageUrl: `/api/files/${docId}/${req.fileId}` }
  }, png)
}

function bigDocument(imageUrl: string): string {
  const parts: string[] = ['# Fifty-page probe\n\n[[toc]]\n']
  for (let s = 1; s <= 25; s++) {
    parts.push(`## Section ${s}\n`)
    for (let p = 0; p < 6; p++) {
      parts.push(`Paragraph ${s}.${p}: the preview has to paginate long prose with **bold**, *italic*, \`inline code\`, a footnote[^f${s}${p}] and inline math $e^{i\\pi} + 1 = 0$ without falling behind the typist. `.repeat(3) + '\n')
      parts.push(`[^f${s}${p}]: Footnote ${s}.${p}.\n`)
    }
    if (s % 3 === 0) parts.push(`![Probe image ${s}](${imageUrl}){width=40%}\n`)
    if (s % 5 === 0) parts.push('```mermaid\nflowchart LR\n  A[Draft] --> B[Review]\n  B --> C{Approved?}\n  C -- yes --> D[Publish]\n  C -- no --> A\n```\n')
    if (s % 2 === 0) parts.push('$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n')
    parts.push('```ts\nexport function add(a: number, b: number): number {\n  return a + b\n}\n```\n')
    parts.push('| Column | Value |\n|---|---|\n| alpha | 1 |\n| beta | 2 |\n')
  }
  return parts.join('\n')
}

async function previewFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 200; i++) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue
      const ok = await f.evaluate(() => !!document.getElementById('mount')).catch(() => false)
      if (ok) return f
    }
    await page.waitForTimeout(100)
  }
  throw new Error('preview iframe not found')
}

async function setDocument(page: Page, frame: Frame, markdown: string, marker: string): Promise<number> {
  await page.evaluate((md) => {
    const ytext = (window as unknown as { __DEBUG_ytext?: { length: number, delete: (i: number, n: number) => void, insert: (i: number, s: string) => void, doc: { transact: (fn: () => void) => void } } }).__DEBUG_ytext
    if (!ytext) throw new Error('__DEBUG_ytext missing (NUXT_PUBLIC_EXPOSE_TEST_HANDLES=1?)')
    ytext.doc.transact(() => {
      ytext.delete(0, ytext.length)
      ytext.insert(0, md)
    })
  }, `${markdown}\n\n${marker}`)
  await frame.waitForFunction(m => (document.getElementById('mount')?.textContent ?? '').includes(m), marker, { timeout: 120_000 })
  return frame.evaluate(() => document.querySelectorAll('#mount .pagedjs_page').length)
}

async function sampleLatency(page: Page, frame: Frame, i: number): Promise<Sample> {
  const marker = `zq${i}x${crypto.randomUUID().slice(0, 4)}`
  await frame.evaluate((m) => {
    const w = window as unknown as { __perfHit?: number, __perfObs?: MutationObserver }
    w.__perfHit = undefined
    w.__perfObs?.disconnect()
    const mount = document.getElementById('mount')
    if (!mount) throw new Error('no #mount')
    const obs = new MutationObserver(() => {
      if (w.__perfHit === undefined && (mount.textContent ?? '').includes(m)) {
        w.__perfHit = performance.timeOrigin + performance.now()
      }
    })
    obs.observe(mount, { childList: true })
    w.__perfObs = obs
  }, marker)
  await page.evaluate(() => {
    const w = window as unknown as { __perfKey?: number, __perfLong?: number, __perfLongObs?: PerformanceObserver }
    w.__perfLong = 0
    w.__perfLongObs?.disconnect()
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__perfLong = (w.__perfLong ?? 0) + e.duration
    })
    obs.observe({ type: 'longtask' })
    w.__perfLongObs = obs
    document.addEventListener('keydown', () => {
      w.__perfKey = performance.timeOrigin + performance.now()
    }, { capture: true })
  })
  await page.keyboard.type(` ${marker}`)
  await frame.waitForFunction(() => (window as unknown as { __perfHit?: number }).__perfHit !== undefined, null, { timeout: 60_000 })
  const hit = await frame.evaluate(() => (window as unknown as { __perfHit?: number }).__perfHit ?? Number.NaN)
  // Let pagination settle completely before the next sample.
  await page.waitForTimeout(1500)
  const { key, long } = await page.evaluate(() => {
    const w = window as unknown as { __perfKey?: number, __perfLong?: number }
    return { key: w.__perfKey ?? Number.NaN, long: w.__perfLong ?? 0 }
  })
  return { latencyMs: hit - key, parentLongTaskMs: long }
}

/** Proportional set size (MiB) of the browser process tree. Linux only. */
function browserPssMiB(rootPid: number): number {
  const children = new Map<number, number[]>()
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      const list = children.get(ppid) ?? []
      list.push(Number(entry))
      children.set(ppid, list)
    } catch { /* process exited */ }
  }
  let totalKb = 0
  const stack = [rootPid]
  while (stack.length > 0) {
    const pid = stack.pop()
    if (pid === undefined) break
    try {
      const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
      const m = /^Pss:\s+(\d+) kB/m.exec(rollup)
      if (m?.[1]) totalKb += Number(m[1])
    } catch { /* process exited */ }
    stack.push(...(children.get(pid) ?? []))
  }
  return totalKb / 1024
}

async function main() {
  const server = await chromium.launchServer({ headless: process.env.PERF_HEADED !== '1' })
  const rootPid = server.process().pid
  if (rootPid === undefined) throw new Error('Chromium launched without a PID; cannot sample its memory')
  const browser = await chromium.connect(server.wsEndpoint())
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const userId = await createUser()
  const cookie = await sessionCookie(userId)
  await context.addCookies([{ ...cookie, url: BASE_URL, httpOnly: true, sameSite: 'Lax' }])
  const page = await context.newPage()
  await page.goto(`${BASE_URL}/`)
  const { docId, imageUrl } = await createDocWithImage(page)
  await page.goto(`${BASE_URL}/d/${docId}`)
  await page.locator('.cm-content').waitFor()
  const frame = await previewFrame(page)

  const docs: Array<{ name: string, markdown: string }> = [
    { name: 'demo x10', markdown: Array.from({ length: 10 }, () => demoMarkdown).join('\n\n<!-- pagebreak -->\n\n') },
    { name: '50 pages (images, mermaid, math)', markdown: bigDocument(imageUrl) }
  ]
  const report: string[] = [`## ${LABEL}`, '', '| Document | Pages | p50 ms | p95 ms | mean ms | parent long tasks p50 ms | browser PSS MiB |', '|---|---|---|---|---|---|---|']
  for (const doc of docs) {
    const pages = await setDocument(page, frame, doc.markdown, `ready${Date.now()}`)
    // Caret to the end of the document for the typing samples.
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await page.waitForTimeout(2000)
    // One warm-up sample (first mermaid/font loads), then the real ones.
    await sampleLatency(page, frame, -1)
    const samples: Sample[] = []
    for (let i = 0; i < ITERATIONS; i++) samples.push(await sampleLatency(page, frame, i))
    const lat = samples.map(s => s.latencyMs).sort((a, b) => a - b)
    const longs = samples.map(s => s.parentLongTaskMs).sort((a, b) => a - b)
    const mean = lat.reduce((a, b) => a + b, 0) / lat.length
    const pss = browserPssMiB(rootPid)
    report.push(`| ${doc.name} | ${pages} | ${percentile(lat, 50).toFixed(0)} | ${percentile(lat, 95).toFixed(0)} | ${mean.toFixed(0)} | ${percentile(longs, 50).toFixed(0)} | ${pss.toFixed(0)} |`)
    console.log(`[perf] ${doc.name}: ${lat.map(v => v.toFixed(0)).join(', ')}`)
  }
  console.log(report.join('\n'))
  await browser.close()
  await server.close()
}

await main()
