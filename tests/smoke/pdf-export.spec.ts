import { test, expect } from '@playwright/test'
import { api, smokeDoc } from './_helpers'
import { waitForSyncDebounce } from '../e2e/fixtures/waits'

// The server-rendered PDF path (renderer sidecar → headless Chromium → paged.js) must not break on the
// mermaid transform: crypto.randomUUID is undefined in the insecure-context render page, so it would throw
// there and the sidecar would time out after 45s. The seeded Demo doc CONTAINS a mermaid diagram, so this is
// the exact case.
test('server-rendered PDF export succeeds for a mermaid doc', async ({ page }) => {
  // Shared run document (globalSetup.ts) — never a new one per attempt.
  const docId = smokeDoc('demo')

  // Open the doc so the Demo body (incl. mermaid) seeds into Y.js and the
  // sync-server persists it to yjs_documents — render-bootstrap replays that.
  await page.goto(`/d/${docId}`)
  await expect(page.locator('.cm-content')).toContainText('markoto', { timeout: 30_000 })
  // Hocuspocus debounces ~2s before flushing to yjs_documents; wait out the
  // batch window so the renderer sees the persisted state.
  await waitForSyncDebounce(page, 4_000)

  const res = await fetch(api(`/api/docs/${docId}/pdf`), { signal: AbortSignal.timeout(120_000) })
  const bytes = new Uint8Array(await res.arrayBuffer())
  expect(res.status, `PDF → ${res.status}`).toBe(200)
  expect(res.headers.get('content-type') ?? '', 'PDF content-type').toContain('application/pdf')
  expect(bytes.byteLength, 'PDF byte size').toBeGreaterThan(1_000)
})
