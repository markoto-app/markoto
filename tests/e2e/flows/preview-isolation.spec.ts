import { readFileSync } from 'node:fs'
import { test, expect, type Frame, type Page } from '@playwright/test'
import { EditorPage } from '../page-objects/Editor'

// Security regression suite (NOT a docs flow — it uses plain Playwright,
// not the `flow` / `editor` fixtures, so it writes no manifest):
//
//   1. The live preview runs in a sandboxed, OPAQUE-origin iframe: content
//      inside it can't read the app's cookies or storage, can't reach the
//      parent DOM, and its same-origin-looking API calls carry no session.
//   2. Everything the preview renders still works through the postMessage
//      protocol: pagination, page zoom, images from /api/files (private
//      doc → file-access token), Mermaid, KaTeX, highlight.js, fragment
//      links, dark mode, the browser print path.
//   3. The app's Content-Security-Policy is sent with a nonce and no page
//      we visit produces a CSP violation.
//   4. No request leaves our own origins: fonts, paged.js, Mermaid, KaTeX
//      and highlight.js are served from /vendor/ (no CDN, no Google Fonts);
//      the only other origins are the ones the CSP names for sync / S3.
//
// Desktop only: on mobile the preview isn't mounted in edit view.

const ACCEL = process.platform === 'darwin' ? 'Meta' : 'Control'

function cspViolations(page: Page): string[] {
  const violations: string[] = []
  page.on('console', (msg) => {
    const text = msg.text()
    if (/Content Security Policy|Content-Security-Policy/i.test(text)) violations.push(text)
  })
  return violations
}

/** Every request URL the page's browser context makes (all frames, incl. the srcdoc iframes). */
function recordRequests(page: Page): string[] {
  const urls: string[] = []
  page.context().on('request', req => urls.push(req.url()))
  page.on('websocket', ws => urls.push(ws.url()))
  return urls
}

/**
 * Requests to an origin that is neither the app nor one the app's CSP
 * names in `connect-src` (sync, S3, Sentry). A CDN or font host shows up
 * here.
 */
function foreignRequests(urls: readonly string[], appOrigin: string, csp: string): string[] {
  const connect = csp.split('; ').find(d => d.startsWith('connect-src ')) ?? ''
  const firstParty = new Set([appOrigin, ...connect.split(' ').filter(s => /^[a-z]+:\/\//.test(s)).map(s => new URL(s).origin)])
  return urls.filter(u => /^(https?|wss?):/.test(u) && !firstParty.has(new URL(u).origin))
}

async function suppressConsentBanner(page: Page): Promise<void> {
  // Same short-circuit as the flow fixture (tests/e2e/fixtures/flow.ts).
  await page.context().route('**/api/consent**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ promptRequired: false, decisions: { essential: true, analytics: false, session_replay: false }, currentVersion: 1 })
      })
      return
    }
    await route.continue()
  })
}

async function previewFrame(page: Page): Promise<Frame> {
  const handle = await page.locator('iframe[title="Document preview"]').elementHandle()
  const frame = await handle?.contentFrame()
  if (!frame) throw new Error('preview iframe has no frame')
  return frame
}

const PNG_BASE64 = readFileSync(new URL('../../../public/icon-192.png', import.meta.url)).toString('base64')

test.describe('preview isolation + CSP', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, 'the preview iframe is not mounted in the mobile edit view')
  })

  test('preview content is isolated from the app and still renders everything', async ({ page }) => {
    test.setTimeout(120_000)
    const violations = cspViolations(page)
    const requests = recordRequests(page)
    await suppressConsentBanner(page)
    const editor = new EditorPage(page)
    await editor.loginAsTestUser('Isolation Probe')

    // The app's own pages carry the nonce CSP.
    const home = await page.goto('/')
    const csp = home?.headers()['content-security-policy'] ?? ''
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/)
    expect(csp).not.toContain('\'unsafe-eval\'')

    // Private doc (logged-in owner) with an uploaded image: the opaque-
    // origin preview has no cookie, so the image needs the file token.
    const { docId, imageUrl } = await page.evaluate(async (pngBase64) => {
      const post = async (url: string, body: unknown) => {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        if (!r.ok) throw new Error(`${url} → ${r.status}`)
        return r.json()
      }
      const doc = await post('/api/docs', { title: 'Isolation probe' })
      const bytes = Uint8Array.from(atob(pngBase64), c => c.codePointAt(0) ?? 0)
      const req = await post('/api/upload/request', { docId: doc.docId, filename: 'probe.png', contentType: 'image/png', size: bytes.length })
      const put = await fetch(req.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes })
      if (!put.ok) throw new Error(`S3 PUT → ${put.status}`)
      await post('/api/upload/confirm', { key: req.key })
      return { docId: doc.docId as string, imageUrl: `/api/files/${doc.docId}/${req.fileId}` }
    }, PNG_BASE64)

    await page.goto(`/d/${docId}`)
    await editor.waitForReady()
    await editor.switchToSplitView()

    // Sandbox: scripts only — never allow-same-origin.
    const iframe = page.locator('iframe[title="Document preview"]')
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')

    const markdown = [
      '# Isolation probe',
      '',
      '[Jump to the end](#the-end)',
      '',
      `![probe](${imageUrl})`,
      '',
      'Inline math $e^{i\\pi}+1=0$ and a code block:',
      '',
      '```ts',
      'const answer: number = 42',
      '```',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[Draft] --> B[Publish]',
      '```',
      '',
      ...Array.from({ length: 60 }, (_, i) => `Paragraph ${i} keeps the document long enough to scroll.`),
      '',
      '## The end',
      '',
      'Done.'
    ].join('\n')
    await page.evaluate((md) => {
      const ytext = (window as unknown as { __DEBUG_ytext?: { length: number, delete: (i: number, n: number) => void, insert: (i: number, s: string) => void } }).__DEBUG_ytext
      if (!ytext) throw new Error('__DEBUG_ytext missing')
      ytext.delete(0, ytext.length)
      ytext.insert(0, md)
    }, markdown)

    const frame = await previewFrame(page)
    await frame.waitForFunction(() => (document.getElementById('mount')?.textContent ?? '').includes('Done.'), null, { timeout: 60_000 })

    // ── Isolation ──────────────────────────────────────────────────────
    const probe = await frame.evaluate(async () => {
      const attempt = (fn: () => unknown): string => {
        try {
          return `ok:${String(fn())}`
        } catch (e) {
          return `blocked:${e instanceof Error ? e.name : 'error'}`
        }
      }
      const me = await fetch('/api/user/me', { credentials: 'include' }).then(r => r.status).catch(() => -1)
      return {
        origin: window.origin,
        cookie: attempt(() => document.cookie),
        localStorage: attempt(() => window.localStorage.length),
        parentDom: attempt(() => window.parent.document.title),
        parentLocation: attempt(() => window.parent.location.href),
        apiWithSession: me
      }
    })
    expect(probe.origin).toBe('null')
    expect(probe.cookie).toMatch(/^blocked:/)
    expect(probe.localStorage).toMatch(/^blocked:/)
    expect(probe.parentDom).toMatch(/^blocked:/)
    expect(probe.parentLocation).toMatch(/^blocked:/)
    // A cross-origin request without the session cookie: refused (401), or
    // stopped before it leaves (-1). Never the signed-in user's data.
    expect([401, -1]).toContain(probe.apiWithSession)

    // A message forged by the iframe content, pretending to be another
    // protocol message, is ignored by the parent (shape check) — and a
    // render message the preview content posts to itself is ignored by
    // the bootstrap (sender check).
    const pagesBefore = await frame.evaluate(() => document.querySelectorAll('#mount .pagedjs_page').length)
    await frame.evaluate(() => {
      window.postMessage({ type: 'render', html: '<p>forged</p>', themeCss: '', fontsImport: '', hljsUrl: '', hljsSri: '', mermaidConfig: '{}', locale: 'en', print: false }, '*')
    })
    await page.waitForTimeout(1000)
    expect(await frame.evaluate(() => (document.getElementById('mount')?.textContent ?? '').includes('forged'))).toBe(false)
    expect(await frame.evaluate(() => document.querySelectorAll('#mount .pagedjs_page').length)).toBe(pagesBefore)

    // ── Rendering still works ──────────────────────────────────────────
    const rendered = await frame.evaluate(async () => {
      const img = Array.from(document.querySelectorAll<HTMLImageElement>('#mount img')).find(i => i.src.includes('/api/files/'))
      if (img) await img.decode().catch(() => undefined)
      const code = document.querySelector('#mount pre code.hljs, #mount pre code[class*="language-ts"]')
      const zoom = document.querySelector<HTMLElement>('#mount .pagedjs_pages')?.style.getPropertyValue('--page-zoom') ?? ''
      return {
        pages: document.querySelectorAll('#mount .pagedjs_page').length,
        imageLoaded: !!img && img.naturalWidth > 0,
        imageHasToken: !!img && img.src.includes('?token='),
        mermaid: !!document.querySelector('#mount div.mermaid > :is(svg, img)'),
        mermaidError: document.querySelector('#mount .mermaid-error')?.textContent ?? null,
        katex: !!document.querySelector('#mount .katex'),
        hljsSheet: !!document.querySelector<HTMLLinkElement>('link#hljs-theme')?.sheet,
        codeColor: code ? getComputedStyle(code).color : '',
        zoom
      }
    })
    expect(rendered.pages).toBeGreaterThan(1)
    expect(rendered.imageHasToken).toBe(true)
    expect(rendered.imageLoaded).toBe(true)
    expect(rendered.mermaidError).toBeNull()
    expect(rendered.mermaid).toBe(true)
    expect(rendered.katex).toBe(true)
    expect(rendered.hljsSheet).toBe(true)
    expect(rendered.zoom).not.toBe('')

    // Status bar page count comes from the `paginated` message.
    await expect(page.getByText(new RegExp(`${rendered.pages} pages?`)).first()).toBeVisible()

    // Fragment link: scrolls inside the preview, never navigates the frame.
    await frame.evaluate(() => window.scrollTo(0, 0))
    await frame.locator('#mount a[href="#the-end"]').first().click()
    await frame.waitForFunction(() => window.scrollY > 200)
    expect(frame.url()).toBe('about:srcdoc')

    // Dark mode: the parent forwards its color mode as a message.
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await frame.waitForFunction(() => document.documentElement.classList.contains('dark-preview'))
    await page.evaluate(() => document.documentElement.classList.remove('dark'))
    await frame.waitForFunction(() => !document.documentElement.classList.contains('dark-preview'))

    // ── Browser print path: same bootstrap, sandboxed, opaque origin ─
    // Headless Chromium's print() returns at once and fires `afterprint`,
    // so the hidden iframe lives only briefly: record what happens from
    // the page side (the protocol messages + the iframe's sandbox flags).
    await page.evaluate(() => {
      const w = window as unknown as { __printLog: string[], __printWin: Window | null }
      w.__printLog = []
      w.__printWin = null
      window.addEventListener('message', (e) => {
        const type = (e.data as { type?: unknown } | null)?.type
        if (e.source === w.__printWin && e.origin === 'null' && typeof type === 'string') w.__printLog.push(type)
      })
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of Array.from(r.addedNodes)) {
            if (n instanceof HTMLIFrameElement && n.getAttribute('aria-hidden') === 'true') {
              w.__printLog.push(`sandbox:${n.getAttribute('sandbox') ?? ''}`)
              w.__printWin = n.contentWindow
            }
          }
        }
      }).observe(document.body, { childList: true })
    })
    await page.locator('.cm-content').click()
    await page.keyboard.press(`${ACCEL}+p`)
    await page.waitForFunction(() => (window as unknown as { __printLog: string[] }).__printLog.includes('print-done'), null, { timeout: 45_000 })
    const printLog = await page.evaluate(() => (window as unknown as { __printLog: string[] }).__printLog)
    expect(printLog).toContain('sandbox:allow-scripts allow-modals')
    expect(printLog).toContain('paginated')
    expect(printLog).not.toContain('iframe-error')
    // Cleaned up after printing.
    await expect(page.locator('iframe[aria-hidden="true"]')).toHaveCount(0)

    expect(violations).toEqual([])
    // Fonts, KaTeX, highlight.js, Mermaid, paged.js all came from /vendor/.
    expect(foreignRequests(requests, new URL(page.url()).origin, csp)).toEqual([])
    expect(requests.some(u => u.includes('/vendor/mermaid@'))).toBe(true)
    expect(requests.some(u => u.includes('/vendor/fonts/') && u.endsWith('.woff2'))).toBe(true)
  })

  test('no CSP violations and no third-party requests on the landing page and the docs site', async ({ page }) => {
    const violations = cspViolations(page)
    const requests = recordRequests(page)
    let csp = ''
    // A production build that bundled the wrong SQLite driver answered every
    // Nuxt Content query with a 500 while all flows stayed green — the docs
    // site was empty and nothing noticed. Fail on any failing content query.
    const failedContentQueries: string[] = []
    page.on('response', (res) => {
      if (res.url().includes('/__nuxt_content/') && res.status() >= 400) failedContentQueries.push(`${res.status()} ${res.url()}`)
    })
    await suppressConsentBanner(page)
    for (const path of ['/', '/docs']) {
      const res = await page.goto(path)
      csp = res?.headers()['content-security-policy'] ?? ''
      expect(csp).toContain('\'nonce-')
      await page.waitForLoadState('networkidle')
    }
    // Client-side navigation inside the docs site (Nuxt Content queries).
    const docLink = page.locator('a[href^="/docs/"]').first()
    await expect(docLink).toBeVisible()
    await docLink.click()
    await page.waitForLoadState('networkidle')
    await expect(page.locator('main h1').first()).toBeVisible()
    expect(failedContentQueries).toEqual([])
    expect(violations).toEqual([])
    expect(foreignRequests(requests, new URL(page.url()).origin, csp)).toEqual([])
  })
})
