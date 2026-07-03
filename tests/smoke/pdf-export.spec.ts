import { test, expect } from '@playwright/test'
import { api, createAnonDoc } from './_helpers'

// The server-rendered PDF path (renderer sidecar → headless Chromium →
// paged.js) is the one that shipped broken: crypto.randomUUID is undefined in
// the insecure-context render page, so it threw on the mermaid transform and
// the sidecar timed out after 45s. The seeded welcome doc CONTAINS a mermaid
// diagram, so this is the exact regression case.
test('server-rendered PDF export succeeds for a mermaid doc', async ({ page }) => {
  const docId = await createAnonDoc()

  // Open the doc so the welcome body (incl. mermaid) seeds into Y.js and the
  // sync-server persists it to yjs_documents — render-bootstrap replays that.
  await page.goto(`/d/${docId}`)
  await expect(page.locator('.cm-content')).toContainText('markoto', { timeout: 30_000 })
  // Hocuspocus debounces ~2s before flushing to yjs_documents; wait out the
  // batch window so the renderer sees the persisted state.
  await page.waitForTimeout(4_000)

  const res = await fetch(api(`/api/docs/${docId}/pdf`), { signal: AbortSignal.timeout(120_000) })
  const bytes = new Uint8Array(await res.arrayBuffer())
  expect(res.status, `PDF → ${res.status}`).toBe(200)
  expect(res.headers.get('content-type') ?? '', 'PDF content-type').toContain('application/pdf')
  expect(bytes.byteLength, 'PDF byte size').toBeGreaterThan(1_000)
})
