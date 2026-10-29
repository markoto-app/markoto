import type { Page } from '@playwright/test'

// Shows a downloaded PDF in a page so a flow can screenshot it.
//
// Headless Chromium has no built-in PDF viewer, so a flow can't capture
// "the PDF you just downloaded" the way a reader would see it. This
// serves a minimal viewer (pdf.js from jsDelivr — the same CDN the app's
// preview already loads paged.js from) at `url`, with the PDF's real
// bytes inlined: the pages in the frame are the file the app produced,
// rendered, not a mock-up. Only the viewer chrome differs from Chrome's.

const PDFJS_VERSION = '4.10.38'

function viewerHtml(pdfBase64: string, pages: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>document.pdf</title>
<style>
  html, body { margin: 0; height: 100%; background: #3c3c3c; }
  #pages { display: flex; gap: 24px; justify-content: center; align-items: center; height: 100%; }
  canvas { box-shadow: 0 2px 12px rgba(0,0,0,.45); background: #fff; }
</style></head>
<body><div id="pages"></div>
<script type="module">
  import * as pdfjs from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs'
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs'
  const bytes = Uint8Array.from(atob('${pdfBase64}'), c => c.charCodeAt(0))
  try {
    const doc = await pdfjs.getDocument({ data: bytes }).promise
    document.body.dataset.pageCount = String(doc.numPages)
    const count = Math.min(${pages}, doc.numPages)
    const maxHeight = window.innerHeight - 48
    const maxWidth = (window.innerWidth - 48 - 24 * (count - 1)) / count
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(maxHeight / base.height, maxWidth / base.width)
      const ratio = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale: scale * ratio })
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      canvas.style.width = (viewport.width / ratio) + 'px'
      canvas.style.height = (viewport.height / ratio) + 'px'
      document.getElementById('pages').appendChild(canvas)
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    }
    document.body.dataset.rendered = String(count)
  } catch (e) {
    document.body.dataset.error = String(e)
  }
</script></body></html>`
}

/**
 * Open `url` in `page` showing the first `pages` pages of `pdf`.
 * Resolves once every page is drawn; returns the PDF's page count.
 */
export async function showPdf(page: Page, url: string, pdf: Buffer, pages = 2): Promise<number> {
  const html = viewerHtml(pdf.toString('base64'), pages)
  await page.route(url, route => route.fulfill({ status: 200, contentType: 'text/html', body: html }))
  await page.goto(url)
  const body = page.locator('body')
  await body.locator('canvas').first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForFunction(() => document.body.dataset.rendered !== undefined || document.body.dataset.error !== undefined, null, { timeout: 30_000 })
  const error = await body.getAttribute('data-error')
  if (error) throw new Error(`[showPdf] pdf.js could not render the file: ${error}`)
  return Number(await body.getAttribute('data-page-count'))
}
